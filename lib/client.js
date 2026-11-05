// ContextPrism DSH Web client.
//
// The browser half of the plugin: one sidebar footer action that opens an
// in-place panel rendering the structured report from
// `GET /context-prism/report`.
//
// v0.9 removed the separate dashboard tab. Opening `/context-prism/dashboard`
// in another window put the state in a document the shell could not theme or
// close, and — because the route used a module-level "last project" — one that
// could show the wrong project entirely. The panel below renders the JSON report
// the host already returns for `context_prism_report`, so there is one data path.
//
// Contract notes for DSH 0.2.1:
//   - A client bundle only REGISTERS its factory here. Every side effect
//     (including CSS) must live inside the factory closure, because the factory
//     is what materializes on first import.
//   - `require` resolves only the seed words declared in `dsh.client.inject`
//     (plus the shell's own instance). A package that is not declared as a seed
//     throws at materialization, so every `require` below has a matching entry
//     in package.json. `react` is the only one.
//   - Slot registrations are effects: `ctx.slots.inject` re-registers whenever
//     the slot appears, and the returned disposer runs on teardown.
//   - No `dangerouslySetInnerHTML`: every value is rendered as a text node, so a
//     chunk source or a session id can never become markup.

window.__ModuleLoader__.load({
  id: "context-prism-dsh-plugin",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    /** Same origin as the host that served this bundle, so no absolute URL. */
    const REPORT_PATH = "/context-prism/report";

    const COLORS = {
      border: "var(--dsw-alias-border-l2, #d0d7de)",
      bg: "var(--dsw-alias-bg-base, #ffffff)",
      bgAlt: "var(--dsw-alias-bg-l1, #f6f8fa)",
      fg: "var(--dsw-alias-label-primary, #1f2328)",
      fgMuted: "var(--dsw-alias-label-secondary, #59636e)",
      danger: "var(--dsw-alias-label-danger, #cf222e)",
    };

    /**
     * Best-effort project hint for the request.
     *
     * The route resolves `?project=` → its configured default → its own cwd, so
     * omitting the parameter is always valid; passing it just pins the panel to
     * the project the shell reports. Nothing here decides authorization.
     */
    function panelProject() {
      if (typeof window === "undefined") return null;
      const candidates = [window.__DSH_CWD__, window.__DSH_PROJECT_ROOT__];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
      }
      return null;
    }

    /** Fetch the report; a non-2xx becomes a readable error, never an empty panel. */
    async function fetchReport(project) {
      const suffix = project ? `?project=${encodeURIComponent(project)}` : "";
      const response = await fetch(`${REPORT_PATH}${suffix}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const detail =
          body && body.error && body.error.message ? body.error.message : response.statusText || "request failed";
        throw new Error(`${response.status} ${detail}`);
      }
      if (!body || typeof body !== "object") throw new Error("report response was not JSON");
      return body;
    }

    function row(label, value) {
      return h(
        "div",
        { key: label, style: { display: "flex", gap: "8px", padding: "2px 0", fontSize: "12px" } },
        h("span", { style: { color: COLORS.fgMuted, minWidth: "120px" } }, label),
        h("span", { style: { color: COLORS.fg, wordBreak: "break-all" } }, String(value)),
      );
    }

    function card(title, children) {
      return h(
        "section",
        {
          key: title,
          style: {
            border: `1px solid ${COLORS.border}`,
            borderRadius: "10px",
            background: COLORS.bg,
            padding: "10px 12px",
            marginBottom: "10px",
          },
        },
        h("h3", { style: { margin: "0 0 6px", fontSize: "13px" } }, title),
        children,
      );
    }

    function countsByKind(report) {
      const byKind = (report.counts && report.counts.byKind) || {};
      const entries = Object.entries(byKind);
      if (entries.length === 0) return h("div", { style: { fontSize: "12px", color: COLORS.fgMuted } }, "none");
      return h(
        "table",
        { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" } },
        h(
          "tbody",
          null,
          entries.map(([kind, count]) =>
            h(
              "tr",
              { key: kind },
              h("td", { style: { padding: "2px 0", color: COLORS.fgMuted } }, kind),
              h("td", { style: { padding: "2px 0", textAlign: "right", color: COLORS.fg } }, String(count)),
            ),
          ),
        ),
      );
    }

    function sessionTable(report) {
      const sessions = Array.isArray(report.sessions) ? report.sessions : [];
      if (sessions.length === 0) {
        return h("div", { style: { fontSize: "12px", color: COLORS.fgMuted } }, "no session-scoped chunks");
      }
      return h(
        "table",
        { style: { width: "100%", borderCollapse: "collapse", fontSize: "11px" } },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ["session", "history", "trajectory", "cursor"].map((label) =>
              h("th", { key: label, style: { textAlign: "left", color: COLORS.fgMuted, fontWeight: 500 } }, label),
            ),
          ),
        ),
        h(
          "tbody",
          null,
          sessions.map((session) =>
            h(
              "tr",
              { key: session.sessionId },
              h("td", { style: { wordBreak: "break-all", color: COLORS.fg } }, session.sessionId),
              h("td", null, String(session.history)),
              h("td", null, String(session.trajectory)),
              h("td", null, String(session.cursor)),
            ),
          ),
        ),
      );
    }

    function reportBody(report) {
      const counts = report.counts || {};
      const byScope = counts.byScope || {};
      const injection = report.injection || {};
      const host = report.host || {};
      const index = report.index || {};
      const project = report.project || {};
      const search = (report.diagnostics && report.diagnostics.search) || null;
      return [
        card(
          "Project",
          h(
            "div",
            null,
            row("root", project.root || "unknown"),
            row("resolved from", project.source || "unknown"),
            row("index", index.path || "unknown"),
            row("backend", index.backend || "unknown"),
            row("revision", index.revision === null || index.revision === undefined ? "n/a" : index.revision),
          ),
        ),
        card(
          "Chunks",
          h(
            "div",
            null,
            row("total", counts.total === undefined ? 0 : counts.total),
            row(
              "by scope",
              `${byScope.sessionScoped || 0} session · ${byScope.projectScoped || 0} project · ${byScope.unowned || 0} unowned`,
            ),
            countsByKind(report),
          ),
        ),
        card("Sessions", sessionTable(report)),
        card(
          "Injection",
          h(
            "div",
            null,
            row("mode", injection.mode || "unknown"),
            row("injected", injection.injections === undefined ? 0 : injection.injections),
            row("skipped empty", injection.skippedEmpty === undefined ? 0 : injection.skippedEmpty),
            row("re-entrant", injection.reentries === undefined ? 0 : injection.reentries),
            row("last", injection.last ? `${injection.last.tokens} tokens` : "none"),
            injection.lastError ? row("last error", injection.lastError.message) : null,
          ),
        ),
        card(
          "Host",
          h(
            "div",
            null,
            row("version", host.version || "unknown"),
            row("target", host.target || "unknown"),
            row("supported", String(host.supported)),
            search
              ? row("search", `${search.ftsErrorCount || 0} fts errors · ${search.likeFallbackCount || 0} LIKE fallbacks`)
              : null,
          ),
        ),
      ];
    }

    function ContextPrismPanel(props) {
      const onClose = props.onClose;
      const state = react.useState({ status: "loading", report: null, error: null });
      const view = state[0];
      const setView = state[1];
      const refreshState = react.useState(0);
      const refreshCounter = refreshState[0];
      const setRefreshCounter = refreshState[1];

      react.useEffect(() => {
        let cancelled = false;
        setView({ status: "loading", report: null, error: null });
        fetchReport(panelProject())
          .then((report) => {
            if (!cancelled) setView({ status: "ready", report, error: null });
          })
          .catch((error) => {
            if (!cancelled) {
              setView({
                status: "error",
                report: null,
                error: String(error && error.message ? error.message : error),
              });
            }
          });
        return () => {
          cancelled = true;
        };
      }, [refreshCounter]);

      const buttonStyle = {
        border: `1px solid ${COLORS.border}`,
        background: COLORS.bg,
        color: COLORS.fg,
        borderRadius: "6px",
        padding: "2px 8px",
        fontSize: "12px",
        cursor: "pointer",
      };

      let body;
      if (view.status === "loading") {
        body = h("div", { style: { fontSize: "12px", color: COLORS.fgMuted } }, "Loading report…");
      } else if (view.status === "error") {
        body = h(
          "div",
          { style: { fontSize: "12px", color: COLORS.danger } },
          `ContextPrism could not load its report: ${view.error}`,
        );
      } else {
        body = reportBody(view.report);
      }

      return h(
        "div",
        {
          style: {
            position: "fixed",
            inset: "0",
            zIndex: 2147483000,
            display: "flex",
            justifyContent: "flex-end",
            background: "rgba(0, 0, 0, 0.28)",
          },
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          "div",
          {
            role: "dialog",
            "aria-label": "ContextPrism report",
            style: {
              width: "min(460px, 100%)",
              height: "100%",
              overflowY: "auto",
              background: COLORS.bgAlt,
              borderLeft: `1px solid ${COLORS.border}`,
              padding: "14px",
              boxSizing: "border-box",
            },
          },
          h(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "10px",
              },
            },
            h("strong", { style: { fontSize: "14px", color: COLORS.fg } }, "ContextPrism"),
            h(
              "div",
              { style: { display: "flex", gap: "6px" } },
              h(
                "button",
                { type: "button", onClick: () => setRefreshCounter((value) => value + 1), style: buttonStyle },
                "Refresh",
              ),
              h("button", { type: "button", onClick: onClose, style: buttonStyle }, "Close"),
            ),
          ),
          body,
        ),
      );
    }

    function ContextPrismAction() {
      const openState = react.useState(false);
      const open = openState[0];
      const setOpen = openState[1];
      return h(
        "span",
        null,
        h(
          "button",
          {
            type: "button",
            title: "Open the ContextPrism report",
            "aria-label": "Open the ContextPrism report",
            onClick: () => setOpen(true),
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              border: `1px solid ${COLORS.border}`,
              background: COLORS.bg,
              color: COLORS.fg,
              borderRadius: "999px",
              padding: "4px 10px",
              fontSize: "12px",
              lineHeight: "16px",
              cursor: "pointer",
            },
          },
          "ContextPrism",
        ),
        open ? h(ContextPrismPanel, { onClose: () => setOpen(false) }) : null,
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
