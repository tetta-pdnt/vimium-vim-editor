(() => {
  "use strict";

  const ALPHABET = "asdfghjklqwertyuiopzxcvbnm";
  const CHANNEL = "vimium-vim-editor";
  const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL("")).origin;
  const EDITABLE_SELECTOR = [
    "textarea",
    "input",
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="textbox"]'
  ].join(",");

  let picker = null;
  let editorSession = null;

  function isValueControl(element) {
    return element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement;
  }

  function isEditable(element) {
    if (!(element instanceof Element)) return false;

    if (element.matches("input")) {
      return [
        "text", "search", "url", "tel", "email", "number", "password"
      ].includes(element.type.toLowerCase());
    }

    return element.matches(
      'textarea,[contenteditable=""],[contenteditable="true"],[role="textbox"]'
    ) || element.isContentEditable;
  }

  function isEligible(element) {
    if (!isEditable(element)) return false;
    if (element.disabled || element.readOnly) return false;
    if (element.getAttribute("aria-disabled") === "true") return false;
    if (element.getAttribute("aria-hidden") === "true") return false;

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      rect.right > 0 && rect.bottom > 0 &&
      rect.left < window.innerWidth && rect.top < window.innerHeight;
  }

  function getEditableFields() {
    return Array.from(document.querySelectorAll(EDITABLE_SELECTOR))
      .filter(isEligible)
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return a.top - b.top || a.left - b.left;
      });
  }

  function makeCode(index, width) {
    let value = index;
    let code = "";
    for (let i = 0; i < width; i += 1) {
      code = ALPHABET[value % ALPHABET.length] + code;
      value = Math.floor(value / ALPHABET.length);
    }
    return code;
  }

  function makeHost() {
    const host = document.createElement("div");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
    return { host, shadow };
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function closePicker() {
    if (!picker) return;
    window.removeEventListener("scroll", picker.updatePositions, true);
    window.removeEventListener("resize", picker.updatePositions, true);
    picker.host.remove();
    picker = null;
  }

  function startPicker() {
    const fields = getEditableFields();
    if (fields.length === 0) return false;

    closePicker();

    const { host, shadow } = makeHost();
    const style = document.createElement("style");
    style.textContent = [
      ".hint{position:fixed;z-index:2147483647;padding:3px 6px;border:1px solid #111;",
      "border-radius:4px;background:#ffe66d;color:#111;font:700 14px/1.2 monospace;",
      "box-shadow:0 1px 4px #0008;pointer-events:none;white-space:pre}",
      ".hint.dim{opacity:.16}",
      ".hint.active{background:#ff9f43;color:#111}"
    ].join("");
    shadow.appendChild(style);

    const width = Math.max(
      2,
      Math.ceil(Math.log(fields.length + 1) / Math.log(ALPHABET.length))
    );
    const entries = fields.map((element, index) => {
      const badge = document.createElement("span");
      const code = makeCode(index, width);
      badge.className = "hint";
      badge.textContent = code;
      badge.setAttribute("aria-hidden", "true");
      shadow.appendChild(badge);
      return { element, badge, code };
    });

    const updatePositions = () => {
      for (const entry of entries) {
        const rect = entry.element.getBoundingClientRect();
        entry.badge.style.left = Math.max(0, rect.left) + "px";
        entry.badge.style.top = Math.max(0, rect.top) + "px";
      }
    };

    picker = { host, entries, buffer: "", updatePositions };
    updatePositions();
    window.addEventListener("scroll", updatePositions, true);
    window.addEventListener("resize", updatePositions, true);
    return true;
  }

  function readValue(element) {
    if (isValueControl(element)) return element.value;
    return element.innerText || element.textContent || "";
  }

  function writeValue(element, value) {
    if (!element.isConnected) {
      throw new Error("The selected field is no longer on the page.");
    }

    const view = element.ownerDocument.defaultView;
    if (isValueControl(element)) {
      const prototype = element instanceof view.HTMLTextAreaElement
        ? view.HTMLTextAreaElement.prototype
        : view.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
    } else {
      element.replaceChildren(element.ownerDocument.createTextNode(value));
    }

    let inputEvent;
    try {
      inputEvent = new view.InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: null
      });
    } catch {
      inputEvent = new view.Event("input", { bubbles: true, composed: true });
    }
    element.dispatchEvent(inputEvent);
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
  }

  function closeEditor(save, value) {
    if (!editorSession) return;

    const current = editorSession;
    editorSession = null;
    window.removeEventListener("message", current.onMessage);

    if (save) {
      try {
        writeValue(current.target, value);
        if (typeof current.target.focus === "function") {
          current.target.focus({ preventScroll: true });
        }
        if (typeof current.target.setSelectionRange === "function") {
          const end = current.target.value.length;
          current.target.setSelectionRange(end, end);
        }
      } catch (error) {
        console.error("[Vimium Text Editor]", error);
        current.returnFocus?.focus?.({ preventScroll: true });
      }
    } else {
      current.returnFocus?.focus?.({ preventScroll: true });
    }

    current.host.remove();
  }

  function openEditor(target) {
    closePicker();

    const { host, shadow } = makeHost();
    const frame = document.createElement("iframe");
    const token = crypto.randomUUID();
    const returnFocus = document.activeElement;
    frame.src = chrome.runtime.getURL("editor.html");
    frame.title = "Vim editor";
    frame.setAttribute("allow", "clipboard-read; clipboard-write");
    frame.style.cssText =
      "all:initial;display:block;position:absolute;inset:0;width:100%;height:100%;";
    shadow.appendChild(frame);

    const onMessage = (event) => {
      if (event.source !== frame.contentWindow ||
          event.origin !== EXTENSION_ORIGIN ||
          event.data?.channel !== CHANNEL) return;

      if (event.data.type === "ready") {
        frame.contentWindow.postMessage({
          channel: CHANNEL,
          type: "init",
          token,
          value: readValue(target)
        }, EXTENSION_ORIGIN);
        return;
      }

      if (event.data.token !== token) return;
      if (event.data.type === "save") {
        closeEditor(true, String(event.data.value ?? ""));
      } else if (event.data.type === "cancel") {
        closeEditor(false);
      }
    };

    editorSession = { host, target, returnFocus, onMessage, token };
    window.addEventListener("message", onMessage);
  }

  function updateHints() {
    if (!picker) return;
    for (const entry of picker.entries) {
      const matches = entry.code.startsWith(picker.buffer);
      entry.badge.classList.toggle("dim", !matches);
      entry.badge.classList.toggle(
        "active",
        matches && picker.buffer.length > 0
      );
      entry.badge.textContent = matches
        ? picker.buffer + entry.code.slice(picker.buffer.length)
        : entry.code;
    }
  }

  function handlePickerKey(event) {
    if (event.key === "Escape") {
      stopEvent(event);
      closePicker();
      return;
    }

    if (event.key === "Backspace") {
      stopEvent(event);
      picker.buffer = picker.buffer.slice(0, -1);
      updateHints();
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key.length !== 1 || !ALPHABET.includes(key)) return;

    stopEvent(event);
    picker.buffer += key;

    const matches = picker.entries.filter(entry =>
      entry.code.startsWith(picker.buffer)
    );

    if (matches.length === 0) {
      picker.buffer = "";
      updateHints();
      return;
    }

    const chosen = matches.find(entry => entry.code === picker.buffer);
    if (chosen) openEditor(chosen.element);
    else updateHints();
  }

  function onKeyDown(event) {
    if (!event.isTrusted || event.isComposing || editorSession) return;

    if (picker) {
      handlePickerKey(event);
      return;
    }

    if (event.altKey && event.key.toLowerCase() === "i" &&
        !event.ctrlKey && !event.metaKey) {
      const target = document.activeElement;
      if (isEligible(target)) {
        stopEvent(event);
        openEditor(target);
      }
      return;
    }

    if (event.key.toLowerCase() !== "i" || !event.shiftKey ||
        event.altKey || event.ctrlKey || event.metaKey) return;

    // Let capital I type normally in a focused field/Vimium Insert mode.
    if (isEditable(document.activeElement)) return;

    if (startPicker()) stopEvent(event);
  }

  window.addEventListener("keydown", onKeyDown, true);
})();
