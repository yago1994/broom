// Minimal CSS selector generator. Walks up from the element building a path
// of `tag.class:nth-of-type(n)` segments, stopping early if it hits an id
// that uniquely identifies the subtree. Good enough for v1; the LLM refines.

export function buildSelector(el: Element): string {
  if (!(el instanceof Element)) throw new Error("not an element");

  // Fast path: stable id.
  if (el.id && isSafeId(el.id) && document.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) {
    return `#${cssEscape(el.id)}`;
  }

  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();

    if (node.id && isSafeId(node.id)) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }

    const stableClasses = Array.from(node.classList)
      .filter(isStableClass)
      .slice(0, 2);
    if (stableClasses.length) {
      part += "." + stableClasses.map(cssEscape).join(".");
    }

    const self: Element = node;
    const parent: Element | null = self.parentElement;
    if (parent) {
      const sameTag: Element[] = Array.from(parent.children).filter(
        (c) => c.tagName === self.tagName,
      );
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(self) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }

    parts.unshift(part);
    node = parent;

    // Try to stop early if current selector already unique.
    const candidate = parts.join(" > ");
    try {
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    } catch {
      // invalid mid-build; keep going
    }
  }
  return parts.join(" > ");
}

function isStableClass(c: string): boolean {
  // Skip tailwind-ish utility/hash classes and anything dynamic-looking.
  if (!c) return false;
  if (/^[a-z0-9_-]+$/i.test(c) === false) return false;
  if (c.length > 40) return false;
  // Heuristic: skip hash-like suffixes (CSS-in-JS).
  if (/(^|[-_])[a-f0-9]{6,}$/i.test(c)) return false;
  return true;
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(id);
}

function cssEscape(s: string): string {
  // CSS.escape is available in all modern browsers.
  return (window.CSS && typeof CSS.escape === "function") ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
