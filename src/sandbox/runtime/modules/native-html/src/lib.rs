//! Native HTML text extraction module.
//!
//! Strips HTML tags and extracts readable text and links.
//! Hand-rolled tag-soup parser — no external dependencies.
//! Registered as "ha:html" in the native module registry.

#![cfg_attr(hyperlight, no_std)]

#[cfg(hyperlight)]
extern crate alloc;

#[cfg(hyperlight)]
use alloc::{
    string::{String, ToString},
    vec::Vec,
};

// Top-level imports are only needed by internal functions, not the module exports
// rquickjs types used in the module are imported within pub mod html

// ── Entity decoding ────────────────────────────────────────────────────

/// Decode common HTML entities in-place.
fn decode_entities(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '&' {
            let mut entity = String::new();
            for ec in chars.by_ref() {
                if ec == ';' {
                    break;
                }
                entity.push(ec);
                if entity.len() > 10 {
                    // Not a real entity — emit as-is
                    result.push('&');
                    result.push_str(&entity);
                    entity.clear();
                    break;
                }
            }
            if !entity.is_empty() {
                match entity.as_str() {
                    "amp" => result.push('&'),
                    "lt" => result.push('<'),
                    "gt" => result.push('>'),
                    "quot" => result.push('"'),
                    "apos" => result.push('\''),
                    "nbsp" => result.push(' '),
                    "ndash" => result.push('\u{2013}'),
                    "mdash" => result.push('\u{2014}'),
                    "copy" => result.push('\u{00A9}'),
                    "reg" => result.push('\u{00AE}'),
                    "hellip" => result.push_str("..."),
                    _ if entity.starts_with('#') => {
                        // Numeric entity: &#123; or &#x1F;
                        let num_str = &entity[1..];
                        let code = if let Some(hex) = num_str.strip_prefix('x') {
                            u32::from_str_radix(hex, 16).ok()
                        } else {
                            num_str.parse::<u32>().ok()
                        };
                        if let Some(cp) = code.and_then(char::from_u32) {
                            result.push(cp);
                        } else {
                            result.push('&');
                            result.push_str(&entity);
                            result.push(';');
                        }
                    }
                    _ => {
                        // Unknown entity — emit as-is
                        result.push('&');
                        result.push_str(&entity);
                        result.push(';');
                    }
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

// ── Tag-soup parser ────────────────────────────────────────────────────

/// Tags whose content should be suppressed (not visible text).
fn is_invisible_tag(name: &str) -> bool {
    matches!(
        name,
        "script" | "style" | "head" | "template" | "noscript" | "svg" | "math"
    )
}

/// Tags that imply a line break in text output.
fn is_block_tag(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "br"
            | "hr"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "li"
            | "tr"
            | "td"
            | "th"
            | "dt"
            | "dd"
            | "blockquote"
            | "pre"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "nav"
            | "aside"
            | "main"
            | "figure"
            | "figcaption"
            | "details"
            | "summary"
    )
}

/// Extract the value of an attribute from a tag string.
/// e.g. extract_attr(r#"a href="https://example.com" class="link""#, "href")
///   → Some("https://example.com")
fn extract_attr<'a>(tag_content: &'a str, attr_name: &str) -> Option<&'a str> {
    // Find attr_name followed by = (with optional spaces)
    let search = attr_name;
    let mut pos = 0;
    while pos < tag_content.len() {
        if let Some(idx) = tag_content[pos..].find(search) {
            let abs_idx = pos + idx;
            // Check it's not part of a longer word
            let before_ok =
                abs_idx == 0 || !tag_content.as_bytes()[abs_idx - 1].is_ascii_alphanumeric();
            let after_idx = abs_idx + search.len();
            // Skip whitespace then expect '='
            let rest = tag_content[after_idx..].trim_start();
            if before_ok && rest.starts_with('=') {
                let val_start = &rest[1..].trim_start();
                if let Some(inner) = val_start.strip_prefix('"') {
                    if let Some(end) = inner.find('"') {
                        return Some(&inner[..end]);
                    }
                } else if let Some(inner) = val_start.strip_prefix('\'') {
                    if let Some(end) = inner.find('\'') {
                        return Some(&inner[..end]);
                    }
                } else {
                    // Unquoted value — ends at whitespace or >
                    let end = val_start
                        .find(|c: char| c.is_whitespace() || c == '>')
                        .unwrap_or(val_start.len());
                    return Some(&val_start[..end]);
                }
            }
            pos = abs_idx + 1;
        } else {
            break;
        }
    }
    None
}

/// Parsed link from HTML.
struct Link {
    href: String,
    text: String,
}

/// Parse HTML and extract text + links in one pass.
fn parse_html(html: &str) -> (String, Vec<Link>) {
    let mut text = String::with_capacity(html.len() / 2);
    let mut links: Vec<Link> = Vec::new();

    let mut invisible_depth: u32 = 0;
    let mut in_anchor = false;
    let mut anchor_href = String::new();
    let mut anchor_text = String::new();

    let bytes = html.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == b'<' {
            // Start of tag
            let tag_start = i + 1;
            // Find end of tag
            let mut tag_end = tag_start;
            let mut in_quote = false;
            let mut quote_char = 0u8;
            while tag_end < len {
                let b = bytes[tag_end];
                if in_quote {
                    if b == quote_char {
                        in_quote = false;
                    }
                } else if b == b'"' || b == b'\'' {
                    in_quote = true;
                    quote_char = b;
                } else if b == b'>' {
                    break;
                }
                tag_end += 1;
            }

            if tag_end >= len {
                // Malformed — no closing >, treat rest as text
                break;
            }

            let tag_content = &html[tag_start..tag_end];
            let is_closing = tag_content.starts_with('/');
            let is_comment = tag_content.starts_with('!');

            if !is_comment {
                // Extract tag name
                let name_str = if is_closing {
                    &tag_content[1..]
                } else {
                    tag_content
                };
                let name_end = name_str
                    .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
                    .unwrap_or(name_str.len());
                let tag_lower = name_str[..name_end].to_ascii_lowercase();
                let tag_name = tag_lower.as_str();

                if is_closing {
                    // Closing tag
                    if is_invisible_tag(tag_name) && invisible_depth > 0 {
                        invisible_depth -= 1;
                    }
                    if tag_name == "a" && in_anchor {
                        in_anchor = false;
                        let link_text = anchor_text.trim().to_string();
                        links.push(Link {
                            href: core::mem::take(&mut anchor_href),
                            text: link_text,
                        });
                        anchor_text.clear();
                    }
                    if is_block_tag(tag_name) && invisible_depth == 0 {
                        // Add newline for block elements
                        if !text.ends_with('\n') {
                            text.push('\n');
                        }
                    }
                } else {
                    // Opening tag
                    if is_invisible_tag(tag_name) {
                        invisible_depth += 1;
                    }
                    if is_block_tag(tag_name) && invisible_depth == 0 && !text.ends_with('\n') {
                        text.push('\n');
                    }
                    if tag_name == "a"
                        && let Some(href) = extract_attr(tag_content, "href")
                    {
                        in_anchor = true;
                        anchor_href = decode_entities(href);
                        anchor_text.clear();
                    }
                    // Self-closing br
                    if tag_name == "br" && invisible_depth == 0 && !text.ends_with('\n') {
                        text.push('\n');
                    }
                }
            }

            i = tag_end + 1;
        } else {
            // Text content
            let text_start = i;
            while i < len && bytes[i] != b'<' {
                i += 1;
            }
            if invisible_depth == 0 {
                let raw = &html[text_start..i];
                let decoded = decode_entities(raw);
                text.push_str(&decoded);
                if in_anchor {
                    anchor_text.push_str(&decoded);
                }
            }
        }
    }

    // Collapse multiple newlines into max 2
    let mut collapsed = String::with_capacity(text.len());
    let mut newline_count = 0u32;
    for c in text.chars() {
        if c == '\n' {
            newline_count += 1;
            if newline_count <= 2 {
                collapsed.push(c);
            }
        } else {
            newline_count = 0;
            collapsed.push(c);
        }
    }

    (collapsed.trim().to_string(), links)
}

// ── rquickjs module ────────────────────────────────────────────────────

/// HTML text extraction module.
///
/// Note: rquickjs generates struct `js_html` from `pub mod html`.
#[rquickjs::module(rename_vars = "camelCase")]
pub mod html {
    #[cfg(hyperlight)]
    use alloc::string::String;

    use rquickjs::{Array, Ctx, Object, Result as QjsResult};

    /// Usage hints for the LLM.
    #[qjs(rename = "_HINTS")]
    pub const _HINTS: &str = "\
htmlToText(html: string): string — strip ALL tags, return plain text.
  Decodes HTML entities (&amp; → &, &#123; → {, etc.).
  Block elements (p, div, h1-h6, li, br) produce line breaks.
  Invisible elements (script, style, head) are suppressed.

extractLinks(html: string): [{href, text}] — extract all <a> links.

parseHtml(html: string): {text, links} — combined extraction in one pass.
  More efficient than calling htmlToText + extractLinks separately.

For web scraping: use fetch plugin to get HTML, then parseHtml() to extract.
";

    /// Extract visible text from HTML, stripping all tags.
    /// Decodes common HTML entities (&amp; &lt; etc).
    /// Block elements (p, div, h1-h6, li, br) produce line breaks.
    /// Invisible elements (script, style, head) are suppressed.
    #[rquickjs::function]
    pub fn html_to_text(html: String) -> String {
        let (text, _) = super::parse_html(&html);
        text
    }

    /// Extract all links from HTML as [{href, text}] pairs.
    /// Returns an array of objects with href and text properties.
    #[rquickjs::function]
    pub fn extract_links<'js>(ctx: Ctx<'js>, html: String) -> QjsResult<Array<'js>> {
        let (_, links) = super::parse_html(&html);
        let arr = Array::new(ctx.clone())?;
        for (i, link) in links.iter().enumerate() {
            let obj = Object::new(ctx.clone())?;
            obj.set("href", link.href.as_str())?;
            obj.set("text", link.text.as_str())?;
            arr.set(i, obj)?;
        }
        Ok(arr)
    }

    /// Extract visible text AND links in one pass (more efficient than
    /// calling htmlToText + extractLinks separately).
    /// Returns {text, links: [{href, text}]}.
    #[rquickjs::function]
    pub fn parse_html<'js>(ctx: Ctx<'js>, input: String) -> QjsResult<Object<'js>> {
        let (text, links) = super::parse_html(&input);
        let result = Object::new(ctx.clone())?;
        result.set("text", text.as_str())?;

        let arr = Array::new(ctx.clone())?;
        for (i, link) in links.iter().enumerate() {
            let obj = Object::new(ctx.clone())?;
            obj.set("href", link.href.as_str())?;
            obj.set("text", link.text.as_str())?;
            arr.set(i, obj)?;
        }
        result.set("links", arr)?;
        Ok(result)
    }
}
