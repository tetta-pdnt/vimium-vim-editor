(() => {
  "use strict";

  const CHANNEL = "vimium-vim-editor";
  let token = null;
  let editor = null;
  let pendingZ = false;
  let pendingZTimer = null;
  let isClosing = false;

  function send(type, value) {
    if (!token || isClosing) return;
    isClosing = true;
    window.parent.postMessage({
      channel: CHANNEL,
      type,
      token,
      ...(type === "save" ? { value } : {})
    }, "*");
  }

  function save() {
    if (!editor) return;
    send("save", editor.getValue());
  }

  function cancel() {
    send("cancel");
  }

  function isNormalMode() {
    return Boolean(editor &&
      editor.container.classList.contains("normal-mode"));
  }

  function handleVimKeys(event) {
    if (!editor) return;

    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopImmediatePropagation();
      save();
      return;
    }

    if (event.key === "Enter") {
      const commandInput = document.querySelector(".ace_dialog input");
      if (commandInput) {
        const command = commandInput.value.trim().replace(/^:/, "").toLowerCase();
        if (/^(w|wq|x|write|writequit)$/.test(command)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          save();
          return;
        }
        if (/^(q!?|quit!?)$/.test(command)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          cancel();
          return;
        }
      }
    }

    if (!isNormalMode() || event.altKey || event.ctrlKey || event.metaKey ||
        event.key !== "Z") {
      pendingZ = false;
      clearTimeout(pendingZTimer);
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    if (pendingZ) {
      pendingZ = false;
      clearTimeout(pendingZTimer);
      save();
      return;
    }

    pendingZ = true;
    clearTimeout(pendingZTimer);
    pendingZTimer = setTimeout(() => {
      pendingZ = false;
    }, 900);
  }

  function init(initialValue) {
    editor = ace.edit("editor");
    editor.setTheme("ace/theme/chrome");
    editor.setKeyboardHandler(ace.require("ace/keyboard/vim").handler);
    editor.session.setMode("ace/mode/text");
    editor.session.setUseWrapMode(true);
    editor.setOptions({
      fontSize: "15px",
      showPrintMargin: false,
      highlightActiveLine: true,
      highlightGutterLine: true,
      scrollPastEnd: 0.3,
      useSoftTabs: true
    });
    editor.setValue(initialValue, -1);
    editor.clearSelection();
    editor.commands.addCommand({
      name: "vimiumSaveAndClose",
      bindKey: { win: "Ctrl-Enter", mac: "Command-Enter" },
      exec: save
    });

    document.getElementById("save").addEventListener("click", save);
    document.getElementById("cancel").addEventListener("click", cancel);
    window.addEventListener("keydown", handleVimKeys, true);

    const modeLabel = document.getElementById("mode");
    const updateMode = () => {
      modeLabel.textContent = isNormalMode() ? "NORMAL" : "INSERT";
    };
    const observer = new MutationObserver(updateMode);
    observer.observe(editor.container, { attributes: true, attributeFilter: ["class"] });
    updateMode();
    editor.focus();
  }

  window.addEventListener("message", event => {
    if (event.source !== window.parent ||
        event.data?.channel !== CHANNEL ||
        event.data?.type !== "init" ||
        typeof event.data.token !== "string") return;

    token = event.data.token;
    init(String(event.data.value ?? ""));
  });

  window.parent.postMessage({
    channel: CHANNEL,
    type: "ready"
  }, "*");
})();
