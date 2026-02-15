use crate::models::{TextChunk, TextSegment};

const TARGET_CHUNK_CHARS: usize = 1500;

/// Info about a message to be chunked.
pub struct MessageInfo {
    pub message_id: String,
    pub session_id: String,
    pub seq: i64,
    pub created_at: i64,
    pub segments: Vec<TextSegment>,
}

/// Merge adjacent messages (same session) into chunks.
///
/// Messages are never split mid-message. Short messages are merged with
/// neighbors until the chunk reaches TARGET_CHUNK_CHARS, then a new chunk
/// starts. A single message exceeding TARGET_CHUNK_CHARS gets its own chunk.
pub fn chunk_messages(messages: &[MessageInfo]) -> Vec<TextChunk> {
    let mut chunks = Vec::new();
    let mut chunk_index = 0;

    // Buffer for accumulating messages into a chunk
    let mut buf_text = String::new();
    let mut buf_first_msg_id = String::new();
    let mut buf_first_seq: i64 = 0;
    let mut buf_first_created_at: i64 = 0;
    let mut buf_session_id = String::new();
    let mut buf_role = String::new();

    for msg in messages {
        // Flatten all segments of this message into one text block
        let msg_text = flatten_segments(&msg.segments);
        if msg_text.is_empty() {
            continue;
        }

        let msg_chars = msg_text.chars().count();

        if buf_text.is_empty() {
            // Start new buffer
            buf_text = msg_text;
            buf_first_msg_id = msg.message_id.clone();
            buf_first_seq = msg.seq;
            buf_first_created_at = msg.created_at;
            buf_session_id = msg.session_id.clone();
            buf_role = dominant_role(&msg.segments);
        } else {
            // Check if adding this message would exceed target
            let combined_chars = buf_text.chars().count() + 1 + msg_chars; // +1 for \n separator
            if combined_chars > TARGET_CHUNK_CHARS {
                // Flush current buffer
                chunks.push(TextChunk {
                    message_id: buf_first_msg_id.clone(),
                    session_id: buf_session_id.clone(),
                    seq: buf_first_seq,
                    created_at: buf_first_created_at,
                    role: buf_role.clone(),
                    text: std::mem::take(&mut buf_text),
                    chunk_index,
                });
                chunk_index += 1;

                // Start new buffer with current message
                buf_text = msg_text;
                buf_first_msg_id = msg.message_id.clone();
                buf_first_seq = msg.seq;
                buf_first_created_at = msg.created_at;
                buf_session_id = msg.session_id.clone();
                buf_role = dominant_role(&msg.segments);
            } else {
                // Merge into buffer
                buf_text.push('\n');
                buf_text.push_str(&msg_text);
            }
        }
    }

    // Flush remaining buffer
    if !buf_text.is_empty() {
        chunks.push(TextChunk {
            message_id: buf_first_msg_id,
            session_id: buf_session_id,
            seq: buf_first_seq,
            created_at: buf_first_created_at,
            role: buf_role,
            text: buf_text,
            chunk_index,
        });
    }

    chunks
}

/// Flatten all segments of a message into a single text with role prefixes.
fn flatten_segments(segments: &[TextSegment]) -> String {
    let mut parts = Vec::new();
    for seg in segments {
        let text = seg.text.trim();
        if text.is_empty() {
            continue;
        }
        parts.push(format!("[{}] {}", seg.role, text));
    }
    parts.join("\n")
}

/// Pick the dominant role from segments (user > assistant > tool).
fn dominant_role(segments: &[TextSegment]) -> String {
    for seg in segments {
        if seg.role == "user" {
            return "user".to_string();
        }
    }
    segments
        .first()
        .map(|s| s.role.clone())
        .unwrap_or_else(|| "unknown".to_string())
}
