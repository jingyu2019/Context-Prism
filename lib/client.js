// ContextPrism DSH Web client.
//
// The browser half of the plugin: one sidebar footer action that opens the
// dashboard served by the host route `/context-prism/dashboard`.
//
// Contract notes for DSH 0.2.1:
//   - A client bundle only REGISTERS its factory here. Every side effect
//     (including CSS) must live inside the factory closure, because the factory
//     is what materializes on first import.
//   - `require` resolves only the seed words declared in `dsh.client.inject`
//     (plus the shell's own instance). A package that is not declared as a seed
//     throws at materialization, so every `require` below has a matching entry
//     in package.json.
//   - Slot registrations are effects: `ctx.slots.inject` re-registers whenever
//     the slot appears, and the returned disposer runs on teardown.

window.__ModuleLoader__.load({
  id: "context-prism-dsh-plugin",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");

    /** Same origin as the host that served this bundle, so no absolute URL. */
    const DASHBOARD_PATH = "/context-prism/dashboard";

    function openDashboard() {
      window.open(DASHBOARD_PATH, "_blank", "noopener,noreferrer");
    }

    function ContextPrismAction() {
      return react.createElement(
        "button",
        {
          type: "button",
          title: "Open the ContextPrism index dashboard",
          "aria-label": "Open the ContextPrism index dashboard",
          onClick: openDashboard,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            border: "1px solid var(--dsw-alias-border-l2, #d0d7de)",
            background: "var(--dsw-alias-bg-base, #ffffff)",
            color: "var(--dsw-alias-label-primary, #1f2328)",
            borderRadius: "999px",
            padding: "4px 10px",
            fontSize: "12px",
            lineHeight: "16px",
            cursor: "pointer",
          },
        },
        "ContextPrism",
      );
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "context-prism",
            order: 100,
          },
          ContextPrismAction,
        ),
      );
    }

    module.exports = { apply };
    return module.exports;
  },
});
