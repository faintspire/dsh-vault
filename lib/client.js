window.__ModuleLoader__.load({
  id: "dsh-vault",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const PANEL_ID = "vault";
    const PANEL_ORDER = 30;
    const API = {
      state: "api/dsh-vault/state",
      sync: "api/dsh-vault/sync",
      config: "api/dsh-vault/config",
    };

    async function call(method, url, body) {
      const init = { method, headers: {} };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error((data && data.error) || res.status + " " + res.statusText);
      return data;
    }

    const s = {
      page: { padding: "26px 30px", maxWidth: 900, fontSize: 14, lineHeight: 1.65, color: "inherit" },
      title: { fontSize: 19, fontWeight: 600, margin: "0 0 2px" },
      sub: { opacity: 0.55, margin: "0 0 22px", fontSize: 13 },
      card: { border: "1px solid rgba(128,128,128,.22)", borderRadius: 10, padding: "14px 16px", marginBottom: 14 },
      cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
      name: { fontWeight: 600, fontSize: 14 },
      grid: { display: "grid", gridTemplateColumns: "80px 1fr", gap: "8px 10px", alignItems: "center" },
      label: { opacity: 0.62, fontSize: 12.5 },
      input: {
        width: "100%",
        boxSizing: "border-box",
        padding: "5px 8px",
        borderRadius: 6,
        border: "1px solid rgba(128,128,128,.32)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 13,
      },
      row: { display: "flex", alignItems: "center", gap: 10 },
      chip: { fontSize: 11.5, padding: "1px 8px", borderRadius: 999, border: "1px solid rgba(128,128,128,.32)", opacity: 0.85 },
      btn: {
        padding: "4px 11px",
        borderRadius: 6,
        border: "1px solid rgba(128,128,128,.32)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        fontSize: 12.5,
      },
      primary: {
        padding: "6px 14px",
        borderRadius: 6,
        border: "1px solid transparent",
        background: "#c96442",
        color: "#fff",
        cursor: "pointer",
        font: "inherit",
        fontSize: 13,
      },
      muted: { opacity: 0.55, fontSize: 12.5 },
      ok: { color: "#3f9142", fontSize: 12.5 },
      bad: { color: "#c9484b", fontSize: 12.5, whiteSpace: "pre-wrap" },
      divider: { height: 1, background: "rgba(128,128,128,.18)", margin: "18px 0" },
    };

    const STATUS_TEXT = {
      pushed: "已推送",
      "up-to-date": "无变化",
      unconfigured: "未配置",
      failed: "失败",
      busy: "同步中",
    };

    function statusChip(status) {
      if (!status) return h("span", { style: s.chip }, "未同步");
      return h("span", { style: s.chip }, STATUS_TEXT[status] || status);
    }

    function PanelIcon() {
      return h(
        "svg",
        { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M8 2 2.5 4.6v5.1L8 12.3l5.5-2.6V4.6L8 2Z",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinejoin: "round",
        }),
        h("path", { d: "M2.6 4.7 8 7.2l5.4-2.5M8 7.2v5", stroke: "currentColor", strokeWidth: 1.3, strokeLinejoin: "round" }),
      );
    }

    function VaultPanel() {
      const [state, setState] = useState(null);
      const [rows, setRows] = useState([]);
      const [time, setTime] = useState("03:30");
      const [enabled, setEnabled] = useState(true);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState("");
      const [error, setError] = useState("");

      const applyState = useCallback((next) => {
        if (!next) return;
        setState(next);
        setRows(next.targets.map((t) => ({ name: t.name, url: t.url, branch: t.branch })));
        setTime(next.schedule.time);
        setEnabled(next.schedule.enabled);
      }, []);

      const refresh = useCallback(async () => {
        try {
          applyState(await call("GET", API.state));
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [applyState]);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const save = async () => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          const data = await call("POST", API.config, {
            repos: rows.map((r) => ({ name: r.name, url: r.url, branch: r.branch })),
            schedule: { enabled, time },
            secretPolicy: state ? state.secretPolicy : undefined,
          });
          applyState(data.state);
          setNotice("配置已保存，立即生效");
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      const sync = async (target) => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          const data = await call("POST", API.sync, target ? { target } : {});
          applyState(data.state);
          setNotice(data.summary || "同步完成");
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      const setRow = (name, patch) => {
        setRows((prev) => prev.map((row) => (row.name === name ? { ...row, ...patch } : row)));
      };

      const lastLine = state && state.lastRunAt
        ? "上次同步 " + new Date(state.lastRunAt).toLocaleString() + " · " + (STATUS_TEXT[state.lastStatus] || state.lastStatus || "未知")
        : "还没有同步记录";

      const nextLine = state && state.nextRunAt
        ? "下次自动同步 " + new Date(state.nextRunAt).toLocaleString()
        : "自动同步已关闭";

      const header = h(
        "div",
        null,
        h("h1", { style: s.title }, "云端备份"),
        h("p", { style: s.sub }, "把技能、记忆和 MCP 配置分别推到私有 Git 仓库。改完点保存立即生效，不需要重启。"),
      );

      const summary = h(
        "div",
        { style: s.card },
        h(
          "div",
          { style: s.row },
          h("span", { style: s.name }, lastLine),
          state && state.busy ? h("span", { style: s.chip }, "正在同步…") : null,
        ),
        h("div", { style: s.muted }, nextLine),
        state && state.lastError ? h("div", { style: s.bad }, state.lastError) : null,
      );

      const targetCards = rows.map((row) => {
        const info = state ? state.targets.find((t) => t.name === row.name) : null;
        return h(
          "div",
          { key: row.name, style: s.card },
          h(
            "div",
            { style: s.cardHead },
            h(
              "div",
              { style: s.row },
              h("span", { style: s.name }, row.name),
              statusChip(info && info.status),
              info && typeof info.count === "number" ? h("span", { style: s.muted }, info.count + " 条") : null,
              info && info.error ? h("span", { style: s.bad }, info.error) : null,
            ),
            h(
              "button",
              { style: s.btn, disabled: busy, onClick: () => sync(row.name) },
              "立即同步",
            ),
          ),
          h(
            "div",
            { style: s.grid },
            h("span", { style: s.label }, "仓库地址"),
            h("input", {
              style: s.input,
              value: row.url,
              placeholder: "git@github.com:you/repo.git",
              onChange: (e) => setRow(row.name, { url: e.target.value }),
            }),
            h("span", { style: s.label }, "分支"),
            h("input", {
              style: s.input,
              value: row.branch,
              onChange: (e) => setRow(row.name, { branch: e.target.value }),
            }),
            h("span", { style: s.label }, "本地克隆"),
            h("span", { style: s.muted }, (info && info.workdir) || "-"),
            h("span", { style: s.label }, "数据源"),
            h(
              "span",
              { style: s.muted },
              info ? info.sources + " 个来源目录/文件（在 cordis.patch.yml 里改）" : "-",
            ),
          ),
        );
      });

      const schedule = h(
        "div",
        { style: s.card },
        h(
          "div",
          { style: s.cardHead },
          h("span", { style: s.name }, "自动同步"),
          h(
            "label",
            { style: { ...s.row, cursor: "pointer" } },
            h("input", { type: "checkbox", checked: enabled, onChange: (e) => setEnabled(e.target.checked) }),
            h("span", { style: s.muted }, enabled ? "已开启" : "已关闭"),
          ),
        ),
        h(
          "div",
          { style: s.grid },
          h("span", { style: s.label }, "每天"),
          h("input", {
            style: { ...s.input, maxWidth: 110 },
            value: time,
            placeholder: "03:30",
            onChange: (e) => setTime(e.target.value),
          }),
        ),
        h("div", { style: s.muted }, "24 小时制 HH:mm。只在本机 DSH 运行时生效。"),
      );

      const actions = h(
        "div",
        { style: { ...s.row, marginTop: 4 } },
        h("button", { style: s.primary, disabled: busy, onClick: save }, busy ? "处理中…" : "保存配置"),
        h("button", { style: s.btn, disabled: busy, onClick: () => sync(null) }, "全部同步"),
        h("button", { style: s.btn, disabled: busy, onClick: refresh }, "刷新状态"),
        notice ? h("span", { style: s.ok }, notice) : null,
      );

      return h(
        "div",
        { style: s.page },
        header,
        summary,
        targetCards,
        h("div", { style: s.divider }),
        schedule,
        actions,
        error ? h("div", { style: { ...s.bad, marginTop: 10 } }, error) : null,
      );
    }

    function apply(ctx) {
      const slots = ctx && ctx.slots;
      if (!slots || typeof slots.register !== "function") return;
      const disposers = [];
      const keep = (dispose) => {
        if (typeof dispose === "function") disposers.push(dispose);
      };
      const registerBoth = () => {
        keep(
          slots.register(
            { name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: () => "云端备份" },
            PanelIcon,
          ),
        );
        keep(slots.register({ name: "main", key: PANEL_ID }, VaultPanel));
      };
      try {
        if (typeof slots.inject === "function") {
          keep(slots.inject("sidebar.panellist", registerBoth));
        } else {
          registerBoth();
        }
      } catch (err) {
        console.warn("[vault] 面板注册失败:", err);
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {}
        }
      });
    }

    const inject = ["slots"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
