import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

/**
 * Shared axe scan, used by the accessibility journey and by any spec that
 * reaches a dialog only it can reach. Scoped to serious/critical impact for
 * the reasons set out at the top of 05-accessibility.spec.ts.
 */
export async function expectNoSeriousViolations(
  page: import("@playwright/test").Page,
  label: string,
) {
  const results = await new AxeBuilder({ page })
    .include("body")
    .exclude("[data-sonner-toaster]") // third-party toast internals, not this app's markup
    .analyze();

  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  test.info().annotations.push({ type: "strict-case", description: label });
  for (const violation of serious) {
    test.info().annotations.push({ type: "strict-axe-rule", description: violation.id });
  }
  const details = serious
    .map(
      (v) =>
        `\n  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} element(s))\n    ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join("\n    ")}`,
    )
    .join("");

  expect(serious, `${label} — serious/critical accessibility violations:${details}`).toHaveLength(0);
}
