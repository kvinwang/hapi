use crate::{state::AppState, types::Permission};
use anyhow::Result;
use axum::{
    extract::{FromRef, FromRequestParts},
    http::{header, request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const DEFAULT_NAMESPACE: &str = "default";

#[derive(Debug, Clone)]
pub struct AuthContext {
    pub user_id: i64,
    pub namespace: String,
    pub permissions: Vec<Permission>,
    pub jti: String,
    pub api_key_id: String,
    pub access_token_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JwtClaims {
    uid: i64,
    ns: String,
    perms: Vec<Permission>,
    jti: String,
    kid: String,
    atid: Option<String>,
    exp: usize,
    iat: usize,
}

#[derive(Debug, Clone)]
pub struct ApiAuth {
    pub api_key_id: String,
    pub access_token_id: Option<String>,
    pub namespace: String,
    pub permissions: Vec<Permission>,
}

#[derive(Debug)]
pub struct AuthError {
    pub status: StatusCode,
    pub message: &'static str,
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        (self.status, Json(serde_json::json!({ "error": self.message }))).into_response()
    }
}

impl<S> FromRequestParts<S> for AuthContext
where
    Arc<AppState>: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AuthError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app_state = Arc::<AppState>::from_ref(state);
        let token = bearer_token(parts)
            .or_else(|| query_token(parts))
            .or_else(|| cookie_token(parts));
        let Some(token) = token else {
            return Err(AuthError { status: StatusCode::UNAUTHORIZED, message: "Missing authorization token" });
        };

        if let Some(ctx) = verify_jwt_token(&app_state, token) {
            return Ok(ctx);
        }
        if let Some(api) = authenticate_cli_token(&app_state, token) {
            return Ok(AuthContext {
                user_id: 0,
                namespace: api.namespace,
                permissions: api.permissions,
                jti: String::new(),
                api_key_id: api.api_key_id,
                access_token_id: api.access_token_id,
            });
        }

        Err(AuthError { status: StatusCode::UNAUTHORIZED, message: "Invalid token" })
    }
}

pub fn authenticate_cli_token(state: &AppState, raw_token: &str) -> Option<ApiAuth> {
    let parsed = parse_access_token(raw_token)?;
    let hash = hash_api_key(&parsed.base_token);

    if let Some(api_key) = state.store.get_api_key_by_hash(&hash) {
        if api_key.revoked_at.is_none() {
            state.store.update_api_key_last_used(&api_key.id);
            return Some(ApiAuth {
                api_key_id: api_key.id,
                access_token_id: None,
                namespace: if parsed.namespace != DEFAULT_NAMESPACE { parsed.namespace } else { api_key.namespace },
                permissions: api_key.permissions,
            });
        }
    }

    if let Some(access_token) = state.store.get_access_token_by_hash(&hash) {
        let now = now_ms();
        if access_token.revoked_at.is_none() && (access_token.expires_at == 0 || access_token.expires_at > now) {
            return Some(ApiAuth {
                api_key_id: access_token.api_key_id,
                access_token_id: Some(access_token.id),
                namespace: if parsed.namespace != DEFAULT_NAMESPACE { parsed.namespace } else { access_token.namespace },
                permissions: access_token.permissions,
            });
        }
    }

    if constant_time_eq(&parsed.base_token, &state.config.cli_api_token) {
        return Some(ApiAuth {
            api_key_id: "__legacy__".to_string(),
            access_token_id: None,
            namespace: parsed.namespace,
            permissions: vec!["admin".to_string()],
        });
    }

    None
}

pub fn create_jwt(state: &AppState, params: &ApiAuth, user_id: i64) -> Result<String> {
    let iat = (now_ms() / 1000) as usize;
    let claims = JwtClaims {
        uid: user_id,
        ns: params.namespace.clone(),
        perms: params.permissions.clone(),
        jti: uuid::Uuid::new_v4().to_string(),
        kid: params.api_key_id.clone(),
        atid: params.access_token_id.clone(),
        iat,
        exp: iat + 300,
    };
    Ok(encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(&state.jwt_secret),
    )?)
}

pub fn verify_jwt_token(state: &AppState, token: &str) -> Option<AuthContext> {
    let data = decode::<JwtClaims>(
        token,
        &DecodingKey::from_secret(&state.jwt_secret),
        &Validation::new(Algorithm::HS256),
    ).ok()?;
    Some(AuthContext {
        user_id: data.claims.uid,
        namespace: data.claims.ns,
        permissions: data.claims.perms,
        jti: data.claims.jti,
        api_key_id: data.claims.kid,
        access_token_id: data.claims.atid,
    })
}

#[derive(Debug, Clone)]
pub struct ParsedAccessToken {
    pub base_token: String,
    pub namespace: String,
}

pub fn parse_access_token(raw: &str) -> Option<ParsedAccessToken> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.rsplit_once(':') {
        Some((base, namespace)) if !base.is_empty() && !namespace.is_empty() => Some(ParsedAccessToken {
            base_token: base.to_string(),
            namespace: namespace.to_string(),
        }),
        Some(_) => None,
        None => Some(ParsedAccessToken {
            base_token: trimmed.to_string(),
            namespace: DEFAULT_NAMESPACE.to_string(),
        }),
    }
}

pub fn hash_api_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    hex::encode(hasher.finalize())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn bearer_token(parts: &Parts) -> Option<&str> {
    let header = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    header.strip_prefix("Bearer ")
}

fn query_token(parts: &Parts) -> Option<&str> {
    let query = parts.uri.query()?;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        if key == "token" {
            return Some(value);
        }
    }
    None
}

fn cookie_token(parts: &Parts) -> Option<&str> {
    let header = parts.headers.get(header::COOKIE)?.to_str().ok()?;
    for item in header.split(';') {
        let trimmed = item.trim();
        if let Some(value) = trimmed.strip_prefix("hapi_token=") {
            return Some(value);
        }
    }
    None
}


pub fn verify_auth_token(state: &AppState, token: &str) -> Option<AuthContext> {
    if let Some(ctx) = verify_jwt_token(state, token) {
        return Some(ctx)
    }
    let api = authenticate_cli_token(state, token)?;
    Some(AuthContext {
        user_id: 0,
        namespace: api.namespace,
        permissions: api.permissions,
        jti: String::new(),
        api_key_id: api.api_key_id,
        access_token_id: api.access_token_id,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn has_permission(perms: &[Permission], target: &str) -> bool {
    if perms.iter().any(|perm| perm == "admin") {
        return true;
    }
    perms.iter().any(|perm| perm == target)
}
