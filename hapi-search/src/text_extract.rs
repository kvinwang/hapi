use crate::models::TextSegment;
use serde_json::Value;

/// Extract searchable text segments from a message content JSON.
///
/// Message content structure varies by role:
/// - user: { role: "user", content: { type: "text", text: "..." } }
/// - assistant/agent: { role: "assistant", content: { message: { content: "..." | [...] } } }
///   or: { role: "assistant", content: { data: [...content blocks...] } }
///   or: { content: [...content blocks...] } (direct from CLI agents)
pub fn extract_text(content: &Value) -> Vec<TextSegment> {
    let role = content
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    match role {
        "user" => extract_user_text(content),
        "assistant" => extract_assistant_text(content),
        _ => {
            // Try to extract from any structure
            let mut segments = extract_user_text(content);
            if segments.is_empty() {
                segments = extract_assistant_text(content);
            }
            segments
        }
    }
}

fn extract_user_text(content: &Value) -> Vec<TextSegment> {
    let mut segments = Vec::new();

    // content.content.text
    if let Some(text) = content
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
    {
        if !text.trim().is_empty() {
            segments.push(TextSegment {
                role: "user".to_string(),
                text: text.to_string(),
            });
        }
    }

    segments
}

fn extract_assistant_text(content: &Value) -> Vec<TextSegment> {
    let mut segments = Vec::new();

    // Try content.content.message.content (Claude format)
    let agent_content = content
        .get("content")
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"));

    // Try content.content.data (alternative format)
    let data_content = content.get("content").and_then(|c| c.get("data"));

    // Try content.content directly if it's an array (direct content blocks)
    let direct_content = content.get("content").filter(|c| c.is_array());

    let blocks = agent_content.or(data_content).or(direct_content);

    if let Some(blocks) = blocks {
        extract_content_blocks(blocks, &mut segments);
    }

    segments
}

fn extract_content_blocks(value: &Value, segments: &mut Vec<TextSegment>) {
    match value {
        Value::String(s) => {
            if !s.trim().is_empty() {
                segments.push(TextSegment {
                    role: "assistant".to_string(),
                    text: s.clone(),
                });
            }
        }
        Value::Array(blocks) => {
            for block in blocks {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match block_type {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            if !text.trim().is_empty() {
                                segments.push(TextSegment {
                                    role: "assistant".to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "tool_use" => {
                        let name = block
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("unknown");
                        let input = block
                            .get("input")
                            .map(|i| truncate_json(i, 500))
                            .unwrap_or_default();

                        if !input.is_empty() {
                            segments.push(TextSegment {
                                role: "tool".to_string(),
                                text: format!("Tool: {name} Input: {input}"),
                            });
                        }
                    }
                    "tool_result" => {
                        let result_text = extract_tool_result_text(block);
                        if !result_text.is_empty() {
                            segments.push(TextSegment {
                                role: "tool_result".to_string(),
                                text: truncate_str(&result_text, 2000),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn extract_tool_result_text(block: &Value) -> String {
    if let Some(content) = block.get("content") {
        match content {
            Value::String(s) => return s.clone(),
            Value::Array(parts) => {
                let mut texts = Vec::new();
                for part in parts {
                    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                        texts.push(text);
                    }
                }
                return texts.join("\n");
            }
            _ => return truncate_json(content, 500),
        }
    }
    String::new()
}

fn truncate_json(value: &Value, max_len: usize) -> String {
    let s = value.to_string();
    truncate_str(&s, max_len)
}

fn truncate_str(s: &str, max_chars: usize) -> String {
    let char_count: usize = s.chars().count();
    if char_count <= max_chars {
        s.to_string()
    } else {
        // Keep first and last parts by char count
        let keep = max_chars / 2;
        let start: String = s.chars().take(keep).collect();
        let end: String = s.chars().skip(char_count - keep).collect();
        format!("{start}...{end}")
    }
}
