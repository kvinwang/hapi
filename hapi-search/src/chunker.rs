use crate::models::{TextChunk, TextSegment};

const TARGET_CHUNK_CHARS: usize = 1500;
const OVERLAP_CHARS: usize = 150;
const MIN_CHUNK_CHARS: usize = 100;

/// Adjust a byte index forward to the nearest char boundary.
fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Adjust a byte index forward to the nearest char boundary (ceil).
fn ceil_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Split text segments from a single message into chunks suitable for embedding.
pub fn chunk_message(
    message_id: &str,
    session_id: &str,
    seq: i64,
    created_at: i64,
    segments: &[TextSegment],
) -> Vec<TextChunk> {
    let mut chunks = Vec::new();
    let mut chunk_index = 0;

    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }

        // Short texts: single chunk
        if text.len() <= TARGET_CHUNK_CHARS {
            chunks.push(TextChunk {
                message_id: message_id.to_string(),
                session_id: session_id.to_string(),
                seq,
                created_at,
                role: segment.role.clone(),
                text: text.to_string(),
                chunk_index,
            });
            chunk_index += 1;
            continue;
        }

        // Longer texts: sliding window with overlap
        let mut start = 0;
        while start < text.len() {
            let end = floor_char_boundary(text, (start + TARGET_CHUNK_CHARS).min(text.len()));

            // Try to break at a sentence or paragraph boundary
            let actual_end = if end < text.len() {
                find_break_point(text, start, end)
            } else {
                end
            };

            let chunk_text = &text[start..actual_end];
            if chunk_text.len() >= MIN_CHUNK_CHARS || start == 0 {
                chunks.push(TextChunk {
                    message_id: message_id.to_string(),
                    session_id: session_id.to_string(),
                    seq,
                    created_at,
                    role: segment.role.clone(),
                    text: chunk_text.to_string(),
                    chunk_index,
                });
                chunk_index += 1;
            }

            if actual_end >= text.len() {
                break;
            }

            // Move forward with overlap
            start = if actual_end > OVERLAP_CHARS {
                ceil_char_boundary(text, actual_end - OVERLAP_CHARS)
            } else {
                actual_end
            };
        }
    }

    chunks
}

/// Find a good break point near `target_end`, looking backwards for sentence boundaries.
fn find_break_point(text: &str, start: usize, target_end: usize) -> usize {
    let search_start = if target_end > 200 {
        floor_char_boundary(text, target_end - 200)
    } else {
        start
    };
    let search_region = &text[search_start..target_end];

    // Prefer paragraph break
    if let Some(pos) = search_region.rfind("\n\n") {
        return search_start + pos + 2;
    }

    // Then sentence break
    for pattern in &[". ", "。", "! ", "? ", "！", "？"] {
        if let Some(pos) = search_region.rfind(pattern) {
            return search_start + pos + pattern.len();
        }
    }

    // Then newline
    if let Some(pos) = search_region.rfind('\n') {
        return search_start + pos + 1;
    }

    // Then word boundary (space)
    if let Some(pos) = search_region.rfind(' ') {
        return search_start + pos + 1;
    }

    // Fall back to target
    target_end
}
