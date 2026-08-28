(() => {
  "use strict";

  const query = new URLSearchParams(window.location.search);
  const scenario = query.get("scenario") || "normal";
  const tenant = query.get("tenant") || "northstar-base";
  const inputs = document.querySelectorAll(".form-grid input");
  const memberInput = inputs[0];
  const findButton = document.querySelector('.form-grid input[type="button"]');
  const clearLink = document.querySelector(".clear-link");
  const messageArea = document.querySelector(".message-area");
  const resultArea = document.querySelector(".result-area");
  const modalShade = document.querySelector(".modal-shade");
  const dialogTitle = document.querySelector(".dialog-title");
  const dialogCopy = document.querySelector(".dialog-copy");
  const dialogActions = document.querySelector(".dialog-actions");

  const members = {
    "84721": { name: "Alex Rivera", suffix: "0042", current: "$1,284.37", available: "$1,120.67", opened: "01/15/2020" },
    "26017": { name: "Jordan Lee", suffix: "7719", current: "$8,912.04", available: "$8,912.04", opened: "03/22/2019" },
  };

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
  const setMessage = (kind, text, label = "Member service status") => {
    messageArea.innerHTML = `<div class="message ${kind}" role="status" aria-label="${escapeHtml(label)}">${escapeHtml(text)}</div>`;
  };
  const clearState = () => { messageArea.innerHTML = ""; resultArea.innerHTML = ""; };

  function showDialog(title, heading, body, buttons) {
    dialogTitle.textContent = title;
    dialogCopy.innerHTML = `<strong>${escapeHtml(heading)}</strong>${escapeHtml(body)}`;
    dialogActions.innerHTML = "";
    for (const buttonSpec of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = buttonSpec.label;
      button.addEventListener("click", buttonSpec.onClick);
      dialogActions.append(button);
    }
    modalShade.hidden = false;
  }

  function hideDialog() {
    modalShade.hidden = true;
  }

  function renderMember(memberNumber, member) {
    resultArea.innerHTML = `
      <div class="member-header">
        <strong>Member profile: ${escapeHtml(member.name)}</strong>
        <span class="synthetic-mark">SYNTHETIC RECORD</span>
      </div>
      <table class="data-table">
        <caption>Member summary</caption>
        <thead><tr><th>Member number</th><th>Member name</th><th>Branch</th><th>Status</th></tr></thead>
        <tbody><tr><td>${escapeHtml(memberNumber)}</td><td>${escapeHtml(member.name)}</td><td>0042</td><td>ACTIVE</td></tr></tbody>
      </table>
      <table class="data-table">
        <caption>Member accounts</caption>
        <thead><tr><th>Account type</th><th>Account suffix</th><th>Current balance</th><th>Available balance</th><th>Status</th><th>Open date</th></tr></thead>
        <tbody>
          <tr><td>Savings</td><td>${escapeHtml(member.suffix)}</td><td class="money">${escapeHtml(member.current)}</td><td class="money">${escapeHtml(member.available)}</td><td>ACTIVE</td><td>${escapeHtml(member.opened)}</td></tr>
          <tr><td>Checking</td><td>1188</td><td class="money">$235.12</td><td class="money">$235.12</td><td>ACTIVE</td><td>06/10/2021</td></tr>
        </tbody>
      </table>`;
    setMessage("", `Member ${memberNumber} loaded from ${tenant}.`);
  }

  function executeSearch() {
    const memberNumber = String(memberInput.value || "").trim();
    clearState();

    if (!/^\d{5}$/.test(memberNumber)) {
      setMessage("outcome", "Validation: enter a five-digit member number.", "Member input validation");
      return;
    }

    if (scenario === "session-expired" && sessionStorage.getItem("handrail-session-restored") !== "true") {
      showDialog(
        "Session expired",
        "Your session has expired.",
        "Manual recovery is required before member servicing can continue.",
        [{ label: "Restore demo session", onClick: () => { sessionStorage.setItem("handrail-session-restored", "true"); hideDialog(); setMessage("", "Synthetic session restored by operator. Select Find Member to continue."); } }],
      );
      return;
    }

    if (memberNumber === "40300") {
      showDialog("Permission denied", "Access denied", "Your role cannot view this synthetic member record.", [{ label: "Close", onClick: hideDialog }]);
      return;
    }

    if (memberNumber === "50000") {
      setMessage("error", "Application error E-500: the member service module could not complete the request.");
      return;
    }

    const member = members[memberNumber];
    const finish = () => {
      if (!member) {
        setMessage("outcome", "No member found.", "Member search result");
        return;
      }
      renderMember(memberNumber, member);
    };

    if (scenario === "slow") {
      setMessage("busy", "Loading member record. Please wait...");
      window.setTimeout(finish, 1400);
      return;
    }

    finish();
  }

  findButton.addEventListener("click", executeSearch);
  memberInput.addEventListener("keydown", (event) => { if (event.key === "Enter") executeSearch(); });
  clearLink.addEventListener("click", (event) => { event.preventDefault(); for (const input of inputs) input.value = ""; clearState(); memberInput.focus(); });

  if (scenario === "notice") {
    showDialog("Quarterly notice", "Security notice", "This synthetic training system displays fabricated records only.", [{ label: "Continue", onClick: hideDialog }]);
  }

  if (scenario === "ambiguous") {
    const duplicate = findButton.cloneNode(true);
    duplicate.addEventListener("click", executeSearch);
    findButton.parentElement.insertBefore(duplicate, clearLink);
  }

  if (scenario === "off-origin") {
    const link = document.createElement("a");
    link.href = "https://example.com/diagnostics";
    link.textContent = "External diagnostics";
    link.target = "_self";
    document.querySelector(".help-pane").append(document.createElement("br"), link);
  }

  const seededMember = query.get("member");
  if (seededMember) memberInput.value = seededMember;
  memberInput.focus();
})();
