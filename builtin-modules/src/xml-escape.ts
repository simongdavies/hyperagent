// @module xml-escape
// @description XML string escaping and simple element builder for OOXML/SVG/HTML
// @created 2026-03-07T00:00:00.000Z
// @modified 2026-03-07T00:00:00.000Z
// @mutable false
// @author system

/**
 * Escape a string for use as XML text content.
 * Handles: & < > (the required three).
 * @param str - Raw string
 * @returns XML-safe string
 */
export function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape a string for use as an XML attribute value.
 * Handles: & < > " ' (all five).
 * @param str - Raw string
 * @returns Attribute-safe string
 */
export function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Create a simple XML element string.
 * @param tag - Element name (e.g. "a:t")
 * @param content - Text content (escaped automatically), null for self-closing
 * @param attrs - Attribute key-value pairs (values escaped automatically)
 * @returns XML element string
 */
export function el(
  tag: string,
  content: string | null | undefined,
  attrs?: Record<string, string | number | boolean>,
): string {
  const attrStr = attrs
    ? " " +
      Object.entries(attrs)
        .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
        .join(" ")
    : "";
  if (content === null || content === undefined) return `<${tag}${attrStr}/>`;
  return `<${tag}${attrStr}>${escapeXml(String(content))}</${tag}>`;
}
