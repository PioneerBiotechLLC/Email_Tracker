/** Font keys stored on Organization → CSS classes that set --font-heading / --font-body (declared in app/layout.tsx). */
const HEADING: Record<string, string> = { merriweather: "font-heading-merriweather", playfair: "font-heading-playfair", inter: "font-heading-inter" };
const BODY: Record<string, string> = { "source-sans": "font-body-source-sans", inter: "font-body-inter", "noto-sans": "font-body-noto-sans" };

export const HEADING_FONTS = [["merriweather", "Merriweather (serif)"], ["playfair", "Playfair Display (serif)"], ["inter", "Inter (sans)"]] as const;
export const BODY_FONTS = [["source-sans", "Source Sans 3"], ["inter", "Inter"], ["noto-sans", "Noto Sans (wide script support)"]] as const;

export function fontClasses(heading: string, body: string): string {
  return `${HEADING[heading] ?? HEADING.merriweather} ${BODY[body] ?? BODY["source-sans"]}`;
}
