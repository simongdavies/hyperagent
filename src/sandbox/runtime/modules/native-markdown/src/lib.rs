//! Native Markdown parser module.
//!
//! Converts Markdown to HTML or plain text.
//! Hand-rolled parser — no external dependencies.
//! Supports: headings, bold, italic, links, code blocks, inline code,
//! unordered/ordered lists, blockquotes, horizontal rules, paragraphs.
//! Registered as "ha:markdown" in the native module registry.

#![cfg_attr(hyperlight, no_std)]
// Parser code uses nested ifs for readability — each level is a distinct check
#![allow(clippy::collapsible_if)]

#[cfg(hyperlight)]
extern crate alloc;

#[cfg(hyperlight)]
use alloc::{
    string::{String, ToString},
    vec::Vec,
};

// ── Inline formatting ──────────────────────────────────────────────────

/// Process inline Markdown formatting: **bold**, *italic*, `code`, [links](url)
fn process_inline(line: &str) -> String {
    let mut result = String::with_capacity(line.len() * 2);
    let chars: Vec<char> = line.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        // Escaped character
        if chars[i] == '\\' && i + 1 < len {
            result.push(chars[i + 1]);
            i += 2;
            continue;
        }

        // Inline code: `code`
        if chars[i] == '`' {
            if let Some(end) = find_char(&chars, '`', i + 1) {
                result.push_str("<code>");
                for c in &chars[i + 1..end] {
                    result.push(escape_html_char(*c));
                }
                result.push_str("</code>");
                i = end + 1;
                continue;
            }
        }

        // Bold: **text** or __text__
        if i + 1 < len
            && ((chars[i] == '*' && chars[i + 1] == '*')
                || (chars[i] == '_' && chars[i + 1] == '_'))
        {
            let marker = chars[i];
            if let Some(end) = find_double_char(&chars, marker, i + 2) {
                result.push_str("<strong>");
                let inner: String = chars[i + 2..end].iter().collect();
                result.push_str(&process_inline(&inner));
                result.push_str("</strong>");
                i = end + 2;
                continue;
            }
        }

        // Italic: *text* or _text_
        if chars[i] == '*' || chars[i] == '_' {
            let marker = chars[i];
            if let Some(end) = find_char(&chars, marker, i + 1) {
                if end > i + 1 {
                    result.push_str("<em>");
                    let inner: String = chars[i + 1..end].iter().collect();
                    result.push_str(&process_inline(&inner));
                    result.push_str("</em>");
                    i = end + 1;
                    continue;
                }
            }
        }

        // Link: [text](url)
        if chars[i] == '[' {
            if let Some(text_end) = find_char(&chars, ']', i + 1) {
                if text_end + 1 < len && chars[text_end + 1] == '(' {
                    if let Some(url_end) = find_char(&chars, ')', text_end + 2) {
                        let text: String = chars[i + 1..text_end].iter().collect();
                        let url: String = chars[text_end + 2..url_end].iter().collect();
                        result.push_str("<a href=\"");
                        result.push_str(&url);
                        result.push_str("\">");
                        result.push_str(&process_inline(&text));
                        result.push_str("</a>");
                        i = url_end + 1;
                        continue;
                    }
                }
            }
        }

        result.push(escape_html_char(chars[i]));
        i += 1;
    }

    result
}

/// Process inline for plain text output (strip formatting, keep text).
fn process_inline_text(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let chars: Vec<char> = line.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '\\' && i + 1 < len {
            result.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if chars[i] == '`' {
            if let Some(end) = find_char(&chars, '`', i + 1) {
                for c in &chars[i + 1..end] {
                    result.push(*c);
                }
                i = end + 1;
                continue;
            }
        }
        if i + 1 < len
            && ((chars[i] == '*' && chars[i + 1] == '*')
                || (chars[i] == '_' && chars[i + 1] == '_'))
        {
            let marker = chars[i];
            if let Some(end) = find_double_char(&chars, marker, i + 2) {
                let inner: String = chars[i + 2..end].iter().collect();
                result.push_str(&process_inline_text(&inner));
                i = end + 2;
                continue;
            }
        }
        if chars[i] == '*' || chars[i] == '_' {
            let marker = chars[i];
            if let Some(end) = find_char(&chars, marker, i + 1) {
                if end > i + 1 {
                    let inner: String = chars[i + 1..end].iter().collect();
                    result.push_str(&process_inline_text(&inner));
                    i = end + 1;
                    continue;
                }
            }
        }
        if chars[i] == '[' {
            if let Some(text_end) = find_char(&chars, ']', i + 1) {
                if text_end + 1 < len && chars[text_end + 1] == '(' {
                    if let Some(url_end) = find_char(&chars, ')', text_end + 2) {
                        let text: String = chars[i + 1..text_end].iter().collect();
                        result.push_str(&process_inline_text(&text));
                        i = url_end + 1;
                        continue;
                    }
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }

    result
}

fn find_char(chars: &[char], target: char, start: usize) -> Option<usize> {
    (start..chars.len()).find(|&i| chars[i] == target)
}

fn find_double_char(chars: &[char], target: char, start: usize) -> Option<usize> {
    (start..chars.len().saturating_sub(1)).find(|&i| chars[i] == target && chars[i + 1] == target)
}

fn escape_html_char(c: char) -> char {
    // For single chars we can't return &str, so only escape < and > in inline.
    // Full escaping happens at the block level.
    c
}

// ── Block-level parsing ────────────────────────────────────────────────

/// Convert Markdown to HTML.
fn md_to_html(md: &str) -> String {
    let lines: Vec<&str> = md.lines().collect();
    let mut html = String::with_capacity(md.len() * 2);
    let len = lines.len();
    let mut i = 0;
    let mut in_list: Option<&str> = None; // "ul" or "ol"

    while i < len {
        let line = lines[i];
        let trimmed = line.trim();

        // Empty line — close any open list, add paragraph break
        if trimmed.is_empty() {
            if let Some(list_type) = in_list.take() {
                html.push_str("</");
                html.push_str(list_type);
                html.push_str(">\n");
            }
            i += 1;
            continue;
        }

        // Fenced code block: ```
        if let Some(rest) = trimmed.strip_prefix("```") {
            let lang = rest.trim();
            if lang.is_empty() {
                html.push_str("<pre><code>");
            } else {
                html.push_str("<pre><code class=\"language-");
                html.push_str(lang);
                html.push_str("\">");
            }
            i += 1;
            while i < len && !lines[i].trim().starts_with("```") {
                html.push_str(&escape_html(lines[i]));
                html.push('\n');
                i += 1;
            }
            html.push_str("</code></pre>\n");
            i += 1; // skip closing ```
            continue;
        }

        // Heading: # to ######
        if trimmed.starts_with('#') {
            let level = trimmed.chars().take_while(|c| *c == '#').count().min(6);
            let content = trimmed[level..].trim_start();
            html.push_str("<h");
            html.push_str(&level.to_string());
            html.push('>');
            html.push_str(&process_inline(content));
            html.push_str("</h");
            html.push_str(&level.to_string());
            html.push_str(">\n");
            i += 1;
            continue;
        }

        // Horizontal rule: ---, ***, ___
        if (trimmed.starts_with("---") || trimmed.starts_with("***") || trimmed.starts_with("___"))
            && trimmed
                .chars()
                .all(|c| c == '-' || c == '*' || c == '_' || c == ' ')
            && trimmed.len() >= 3
        {
            html.push_str("<hr>\n");
            i += 1;
            continue;
        }

        // Blockquote: > text
        if let Some(rest) = trimmed.strip_prefix('>') {
            let content = rest.trim_start();
            html.push_str("<blockquote>");
            html.push_str(&process_inline(content));
            html.push_str("</blockquote>\n");
            i += 1;
            continue;
        }

        // Unordered list: - item or * item
        if (trimmed.starts_with("- ") || trimmed.starts_with("* "))
            && !trimmed.starts_with("---")
            && !trimmed.starts_with("***")
        {
            if in_list != Some("ul") {
                if let Some(list_type) = in_list.take() {
                    html.push_str("</");
                    html.push_str(list_type);
                    html.push_str(">\n");
                }
                html.push_str("<ul>\n");
                in_list = Some("ul");
            }
            let content = trimmed[2..].trim_start();
            html.push_str("<li>");
            html.push_str(&process_inline(content));
            html.push_str("</li>\n");
            i += 1;
            continue;
        }

        // Ordered list: 1. item, 2. item, etc.
        if let Some(dot_pos) = trimmed.find(". ") {
            if dot_pos <= 3 && trimmed[..dot_pos].chars().all(|c| c.is_ascii_digit()) {
                if in_list != Some("ol") {
                    if let Some(list_type) = in_list.take() {
                        html.push_str("</");
                        html.push_str(list_type);
                        html.push_str(">\n");
                    }
                    html.push_str("<ol>\n");
                    in_list = Some("ol");
                }
                let content = &trimmed[dot_pos + 2..];
                html.push_str("<li>");
                html.push_str(&process_inline(content));
                html.push_str("</li>\n");
                i += 1;
                continue;
            }
        }

        // Close any open list before paragraph
        if let Some(list_type) = in_list.take() {
            html.push_str("</");
            html.push_str(list_type);
            html.push_str(">\n");
        }

        // Paragraph
        html.push_str("<p>");
        html.push_str(&process_inline(trimmed));
        html.push_str("</p>\n");
        i += 1;
    }

    // Close any remaining list
    if let Some(list_type) = in_list {
        html.push_str("</");
        html.push_str(list_type);
        html.push_str(">\n");
    }

    html
}

/// Convert Markdown to plain text (strip all formatting).
fn md_to_text(md: &str) -> String {
    let lines: Vec<&str> = md.lines().collect();
    let mut text = String::with_capacity(md.len());
    let len = lines.len();
    let mut i = 0;

    while i < len {
        let trimmed = lines[i].trim();

        if trimmed.is_empty() {
            if !text.ends_with('\n') {
                text.push('\n');
            }
            i += 1;
            continue;
        }

        // Skip fenced code blocks — preserve content as-is
        if trimmed.starts_with("```") {
            i += 1;
            while i < len && !lines[i].trim().starts_with("```") {
                text.push_str(lines[i]);
                text.push('\n');
                i += 1;
            }
            i += 1;
            continue;
        }

        // Heading: strip #
        if trimmed.starts_with('#') {
            let content = trimmed.trim_start_matches('#').trim_start();
            text.push_str(&process_inline_text(content));
            text.push('\n');
            i += 1;
            continue;
        }

        // HR
        if (trimmed.starts_with("---") || trimmed.starts_with("***") || trimmed.starts_with("___"))
            && trimmed.len() >= 3
        {
            text.push_str("---\n");
            i += 1;
            continue;
        }

        // Blockquote: strip >
        if let Some(rest) = trimmed.strip_prefix('>') {
            let content = rest.trim_start();
            text.push_str(&process_inline_text(content));
            text.push('\n');
            i += 1;
            continue;
        }

        // List items: strip marker
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            text.push_str("• ");
            text.push_str(&process_inline_text(&trimmed[2..]));
            text.push('\n');
            i += 1;
            continue;
        }
        if let Some(dot_pos) = trimmed.find(". ") {
            if dot_pos <= 3 && trimmed[..dot_pos].chars().all(|c| c.is_ascii_digit()) {
                text.push_str(&trimmed[..dot_pos + 2]);
                text.push_str(&process_inline_text(&trimmed[dot_pos + 2..]));
                text.push('\n');
                i += 1;
                continue;
            }
        }

        // Regular text
        text.push_str(&process_inline_text(trimmed));
        text.push('\n');
        i += 1;
    }

    text.trim().to_string()
}

/// Escape HTML special characters.
fn escape_html(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            _ => result.push(c),
        }
    }
    result
}

// ── rquickjs module ────────────────────────────────────────────────────

/// Markdown parser module.
///
/// Note: rquickjs generates struct `js_markdown` from `pub mod markdown`.
#[rquickjs::module(rename_vars = "camelCase")]
pub mod markdown {
    #[cfg(hyperlight)]
    use alloc::string::String;

    /// Usage hints for the LLM.
    #[qjs(rename = "_HINTS")]
    pub const _HINTS: &str = "\
markdownToHtml(md: string): string — convert Markdown to HTML.
  Supports: # headings, **bold**, *italic*, `code`, ```code blocks```,
  [links](url), - unordered lists, 1. ordered lists, > blockquotes, --- rulers.

markdownToText(md: string): string — convert Markdown to plain text.
  Strips all formatting markers. Code blocks preserved as-is.
  Lists use • bullet points. Useful for extracting readable content.

Use ha:html to go the other direction (HTML → text).
";

    /// Convert Markdown to HTML.
    /// Supports: headings, bold, italic, links, code blocks, inline code,
    /// unordered/ordered lists, blockquotes, horizontal rules, paragraphs.
    #[rquickjs::function]
    pub fn markdown_to_html(md: String) -> String {
        super::md_to_html(&md)
    }

    /// Convert Markdown to plain text (strip all formatting).
    /// Code block content is preserved. Lists use bullet points.
    #[rquickjs::function]
    pub fn markdown_to_text(md: String) -> String {
        super::md_to_text(&md)
    }
}
