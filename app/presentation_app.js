const state = {
  currentMachineId: null,
  overview: null,
  machines: [],
  meta: null,
  how: null,
  machineLabels: {},
};

// This is a tiny single-page app. We keep one in-memory state object, fetch all
// notebook-backed API data at startup, and then re-render sections as the user clicks around.
const views = ["overview", "machine-list", "machine-detail", "try-it", "how-it-works"];

function showView(viewId) {
  for (const view of views) {
    document.getElementById(view).classList.toggle("is-active", view === viewId);
  }
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === viewId || (viewId === "machine-detail" && button.dataset.view === "machine-list"));
  });
}

async function api(url, options = {}) {
  // All backend calls go through one helper so the UI gets consistent JSON error handling.
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed." }));
    throw new Error(error.error || "Request failed.");
  }
  return response.json();
}

function riskClass(risk) {
  if (risk === "HIGH") return "high";
  if (risk === "MEDIUM" || risk === "REVIEW") return "medium";
  return "low";
}

function probabilityPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function titleCase(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()).trim();
}

function displayMachineName(machineId) {
  return state.machineLabels[machineId] || machineId;
}

function explanationRowsHtml(items) {
  return items.map((item) => {
    const positive = item.contribution >= 0;
    const width = Math.min(Math.abs(item.contribution) * 300, 100);
    return `
      <div class="explain-row">
        <div>
          <div class="explain-rule">${escapeHtml(item.feature_rule)}</div>
          <div class="explain-sub">${escapeHtml(item.currentValueLabel || "Current value unavailable")}</div>
        </div>
        <div class="explain-bar"><div class="explain-fill ${positive ? "" : "negative"}" style="width:${width}%"></div></div>
        <div class="explain-score ${positive ? "positive" : "negative"}">${positive ? "+" : ""}${item.contribution.toFixed(2)}</div>
      </div>
    `;
  }).join("");
}

function thresholdExplanationHtml(result, thresholdInfo) {
  const chosen = result.threshold;
  const defaultThreshold = thresholdInfo.defaultThreshold;
  const chosenDisplay = Number(chosen.toFixed(2));
  const defaultDisplay = Number(defaultThreshold.toFixed(2));
  const comparison = chosenDisplay < defaultDisplay
    ? "lower than the notebook default"
    : chosenDisplay > defaultDisplay
      ? "higher than the notebook default"
      : "the same as the notebook default";
  const tradeoff = chosenDisplay < defaultDisplay
    ? "This is a more sensitive setting: it catches more possible failures, but creates more false alarms."
    : chosenDisplay > defaultDisplay
      ? "This is a stricter setting: it reduces false alarms, but increases the chance of missing real failures."
      : "This uses the notebook's cost-tuned operating point.";
  const outcome = result.inspectionFlag
    ? "At this threshold, the model would flag the machine for action."
    : "At this threshold, the model would leave the machine unflagged.";
  const assumptions = thresholdInfo.costAssumptions;
  return `
    <div class="threshold-note">
      <strong>Default threshold logic:</strong> the notebook picked ${defaultThreshold.toFixed(2)} by minimizing estimated operating cost on the validation split.<br><br>
      <strong>Cost assumptions:</strong> one missed failure is treated as about &pound;${assumptions.missedFailureGbp.toLocaleString()}, while one false alarm is treated as about &pound;${assumptions.falseAlarmGbp.toLocaleString()}. That is a ${assumptions.ratio}:1 penalty ratio in favour of catching failures.<br><br>
      <strong>Validated model behaviour at the default threshold:</strong> recall ${probabilityPercent(thresholdInfo.recall)}, precision ${probabilityPercent(thresholdInfo.precision)}.${thresholdInfo.flaggedMachines ? ` The notebook export currently flags ${thresholdInfo.flaggedMachines} machines for review in the demo fleet.` : ""}<br><br>
      <strong>Current threshold:</strong> ${chosen.toFixed(2)}. This is ${comparison} (${defaultThreshold.toFixed(2)}).<br><br>
      ${tradeoff}<br><br>
      ${outcome}
    </div>
  `;
}

function renderOverview() {
  // Overview is a pure render from the exported notebook payload: no extra computation here.
  const data = state.overview;
  const el = document.getElementById("overview");
  const topRows = data.topMachines.map((machine) => `
    <tr>
      <td class="rank">${machine.rank}</td>
      <td>
        <div class="machine-name">${displayMachineName(machine.machineId)}</div>
        <div class="machine-meta">Grade ${machine.type}</div>
      </td>
      <td class="machine-summary">${machine.recommendation}</td>
      <td class="risk-cell">
        <div class="risk-wrap">
          <div class="risk-bar"><div class="risk-fill ${riskClass(machine.risk)}" style="width:${machine.riskPercent}%"></div></div>
          <strong>${machine.riskPercent}%</strong>
          <span class="risk-tag ${riskClass(machine.risk)}">${machine.risk}</span>
        </div>
      </td>
    </tr>
  `).join("");

  el.innerHTML = `
    <div class="eyebrow">Notebook demo</div>
    <h1 class="page-title"><span style="background:#144fbe; padding: 0 2px;">Predictive maintenance overview</span></h1>
    <p class="page-subtitle">This page shows the current demo fleet, the machines that cross the chosen decision threshold, and which ones should be inspected first.</p>
    <div class="divider"></div>

    <div class="cards">
      <div class="card">
        <div class="label">Machines monitored</div>
        <div class="value">${data.summary.machinesMonitored}</div>
        <div class="note">machines in the notebook export</div>
      </div>
      <div class="card warning">
        <div class="label">Flagged today</div>
        <div class="value">${data.summary.flaggedToday}</div>
        <div class="note">${Math.round((data.summary.flaggedToday / data.summary.machinesMonitored) * 100)}% of fleet</div>
      </div>
      <div class="card danger">
        <div class="label">High risk</div>
        <div class="value">${data.summary.highRisk}</div>
        <div class="note">probability at or above 70%</div>
      </div>
      <div class="card">
        <div class="label">Default threshold</div>
        <div class="value">${state.meta.threshold.toFixed(2)}</div>
        <div class="note">validation-tuned operating point</div>
      </div>
    </div>

    <div class="section-panel">
      <div class="section-header">Top machines to inspect first</div>
      <div class="section-body" style="padding:0 18px 6px;">
        <table class="machines-table">
          ${topRows}
        </table>
      </div>
    </div>

    <div class="hint-panel">Click any machine in <strong>Machine view</strong> to inspect the sensor readings and local explanation behind the score.</div>
  `;
}

function renderMachineList() {
  // The machine list only includes assets the notebook export marked for review/inspection.
  const rows = state.machines.map((machine) => `
    <tr class="machine-row" data-machine-id="${machine.machineId}">
      <td>
        <div class="machine-name">${displayMachineName(machine.machineId)}</div>
      </td>
      <td class="machine-location">Grade ${machine.type}</td>
      <td class="risk-cell">
        <div class="risk-wrap">
          <div class="risk-bar"><div class="risk-fill ${riskClass(machine.risk)}" style="width:${Math.round(machine.probability * 100)}%"></div></div>
          <strong>${Math.round(machine.probability * 100)}%</strong>
          <span class="risk-tag ${riskClass(machine.risk)}">${machine.risk}</span>
        </div>
      </td>
    </tr>
  `).join("");

  const el = document.getElementById("machine-list");
  el.innerHTML = `
    <div class="eyebrow">Machine view</div>
    <h1 class="page-title">Pick a machine</h1>
    <p class="page-subtitle">Click any flagged machine to see the prediction and why it was made.</p>
    <div class="divider"></div>

    <div class="section-panel">
      <div class="section-body" style="padding:0 18px 6px;">
        <table class="machines-table list-table">
          ${rows}
        </table>
      </div>
    </div>
  `;

  el.querySelectorAll(".machine-row").forEach((row) => {
    row.addEventListener("click", async () => {
      await loadMachineDetail(row.dataset.machineId);
    });
  });
}

async function loadMachineDetail(machineId) {
  // Detail data stays lazy-loaded so the list view can render quickly.
  const detail = await api(`/api/machines/${machineId}`);
  state.currentMachineId = machineId;
  renderMachineDetail(detail);
  showView("machine-detail");
}

function renderMachineDetail(detail) {
  // LIME explanations are already prepared by the export step; the frontend just
  // formats them and maps contribution sign to colour/direction.
  const riskClassName = riskClass(detail.risk);
  const explanationRows = explanationRowsHtml(detail.lime);

  const el = document.getElementById("machine-detail");
  el.innerHTML = `
    <button class="back-btn" id="detail-back">&lt; Back</button>
    <div class="eyebrow">Flagged machine profile</div>
    <div class="detail-header">
      <h1 class="page-title" style="margin-bottom:0;">${displayMachineName(detail.machineId)}</h1>
      <div class="detail-risk ${riskClassName}">&bull; ${detail.risk}</div>
    </div>
    <p class="page-subtitle">Grade ${detail.type}. This is a generic demo label rather than a real plant asset name or location.</p>
    <div class="divider"></div>

    <div class="detail-grid">
      <div class="section-panel prediction-panel ${riskClassName}">
        <div class="section-header">Prediction</div>
        <div class="section-body">
          <div class="big-prob">${detail.predictionPercent}<span>%</span><span class="muted-inline">chance of failure</span></div>
          <div class="decision-banner ${riskClassName}">${detail.recommendation}</div>
        </div>
      </div>

      <div class="section-panel">
        <div class="section-header">Sensor readings</div>
        <div class="section-body">
          <div class="reading-grid">
            <div class="reading-box">
              <div class="reading-label">Torque</div>
              <div class="reading-value">${detail.sensorReadings["Torque [Nm]"]} Nm</div>
            </div>
            <div class="reading-box">
              <div class="reading-label">Tool wear</div>
              <div class="reading-value">${detail.sensorReadings["Tool wear [min]"]} min</div>
            </div>
            <div class="reading-box">
              <div class="reading-label">Speed</div>
              <div class="reading-value">${detail.sensorReadings["Rotational speed [rpm]"]} rpm</div>
            </div>
            <div class="reading-box">
              <div class="reading-label">Process temp</div>
              <div class="reading-value">${detail.sensorReadings["Process temperature [K]"]} K</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="section-panel">
      <div class="section-header">Why was it flagged?</div>
      <div class="section-body">
        <p class="explain-text">Each row is a sensor pattern that pushed the prediction up or down. Red bars push toward failure, green bars push toward healthy.</p>
        <div class="explain-list">${explanationRows}</div>
      </div>
    </div>
  `;

  document.getElementById("detail-back").addEventListener("click", () => showView("machine-list"));
}

function renderTryIt() {
  // Unlike the static dashboard sections, "Try it" is interactive: slider values are
  // gathered client-side and posted back to the live prediction endpoint.
  const meta = state.meta;
  const defaults = meta.featureDefaults;
  const scenarioGroups = meta.scenarioGroups || {};
  const scenarioGroupsHtml = Object.entries(scenarioGroups).map(([type, profiles]) => `
    <div class="scenario-group">
      <div class="scenario-group-title">Type ${escapeHtml(type)}</div>
      <div class="scenario-list">
        ${profiles.map((profile, index) => `
          <button class="scenario-btn ${riskClass(profile.risk)}" data-scenario-type="${escapeHtml(type)}" data-scenario-index="${index}">
            ${escapeHtml(profile.label)} · ${Math.round(profile.probability * 100)}%
          </button>
        `).join("")}
      </div>
    </div>
  `).join("");

  const el = document.getElementById("try-it");
  el.innerHTML = `
    <div class="eyebrow">Try it</div>
    <h1 class="page-title">Move the sliders, get a prediction</h1>
    <p class="page-subtitle">Pretend you are reading sensors from a machine. Move the values around and watch the prediction change.</p>
    <p class="page-subtitle" style="max-width:none;">These profiles are taken from real model-scored examples. Each machine grade has a healthy, medium-risk, and high-risk starting point.</p>
    <div class="divider"></div>

    <div class="try-grid">
      <div class="section-panel">
        <div class="section-header">Sensor inputs</div>
        <div class="section-body">
          ${slider("Torque [Nm]", defaults["Torque [Nm]"], meta.featureBounds["Torque [Nm]"].min, meta.featureBounds["Torque [Nm]"].max, 0.1, "Nm")}
          ${slider("Tool wear [min]", defaults["Tool wear [min]"], meta.featureBounds["Tool wear [min]"].min, meta.featureBounds["Tool wear [min]"].max, 1, "min")}
          ${slider("Rotational speed [rpm]", defaults["Rotational speed [rpm]"], meta.featureBounds["Rotational speed [rpm]"].min, meta.featureBounds["Rotational speed [rpm]"].max, 1, "rpm")}
          ${slider("Process temperature [K]", defaults["Process temperature [K]"], meta.featureBounds["Process temperature [K]"].min, meta.featureBounds["Process temperature [K]"].max, 0.1, "K")}
          ${slider("Air temperature [K]", defaults["Air temperature [K]"], meta.featureBounds["Air temperature [K]"].min, meta.featureBounds["Air temperature [K]"].max, 0.1, "K")}

          <div class="input-group">
            <div class="input-label">Machine grade</div>
            <div class="grade-buttons">
              ${meta.typeOptions.map(type => `<button class="grade-btn ${type === defaults["Type"] ? "is-active" : ""}" data-type="${type}">${type}</button>`).join("")}
            </div>
          </div>
        </div>
      </div>

      <div class="section-panel">
        <div class="section-header">Prediction</div>
        <div class="section-body">
          <div id="try-prediction" class="prediction-box low">
            <div class="prediction-mini-label">Failure probability</div>
            <div class="prob">--%</div>
            <div class="prediction-pill">Loading</div>
            <div class="prediction-note">Calculating prediction...</div>
          </div>
          <div class="prediction-mini-label" style="margin-top:18px;">Try a scenario</div>
          <div class="scenario-groups">${scenarioGroupsHtml}</div>

          <div class="input-group threshold-group">
            <div class="input-row">
              <div class="input-label">Decision threshold</div>
              <div class="input-value"><span id="Decision-threshold-value">${meta.threshold.toFixed(2)}</span></div>
            </div>
            <input type="range" id="Decision-threshold" min="0.01" max="0.99" step="0.01" value="${meta.threshold}">
            <div id="threshold-explanation" class="threshold-note">
              The notebook chose the default threshold by balancing missed-failure cost against false-alarm cost.
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="section-panel">
      <div class="section-header">Why did the model say that?</div>
      <div class="section-body">
        <p class="explain-text">The live explanation below updates with the sliders. Red bars push toward failure, green bars push toward healthy.</p>
        <div id="try-explanation" class="explain-list">
          <div class="explain-sub">Waiting for prediction...</div>
        </div>
      </div>
    </div>
  `;

  bindTryIt(meta);
}

function applyTryItScenario(preset) {
  document.getElementById("Torque--Nm-").value = preset["Torque [Nm]"];
  document.getElementById("Tool-wear--min-").value = preset["Tool wear [min]"];
  document.getElementById("Rotational-speed--rpm-").value = preset["Rotational speed [rpm]"];
  document.getElementById("Process-temperature--K-").value = preset["Process temperature [K]"];
  document.getElementById("Air-temperature--K-").value = preset["Air temperature [K]"];
  document.getElementById("Torque--Nm--value").textContent = preset["Torque [Nm]"];
  document.getElementById("Tool-wear--min--value").textContent = preset["Tool wear [min]"];
  document.getElementById("Rotational-speed--rpm--value").textContent = preset["Rotational speed [rpm]"];
  document.getElementById("Process-temperature--K--value").textContent = preset["Process temperature [K]"];
  document.getElementById("Air-temperature--K--value").textContent = preset["Air temperature [K]"];
  document.querySelectorAll(".grade-btn").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.type === preset["Type"]));
}

function slider(name, value, min, max, step, unit) {
  // Input ids are generated from the feature name so the same naming scheme can be reused
  // when collecting values and when applying preset scenarios.
  const id = name.replace(/[^a-z0-9]/gi, "-");
  return `
    <div class="input-group">
      <div class="input-row">
        <div class="input-label">${name.replace(" [Nm]", "").replace(" [min]", "").replace(" [rpm]", "").replace(" [K]", "")}</div>
        <div class="input-value"><span id="${id}-value">${value}</span> ${unit}</div>
      </div>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
    </div>
  `;
}

function collectTryItPayload() {
  // Build the exact feature dictionary expected by POST /api/predict.
  const typeButton = document.querySelector(".grade-btn.is-active");
  return {
    "Type": typeButton.dataset.type,
    "Torque [Nm]": parseFloat(document.getElementById("Torque--Nm-").value),
    "Tool wear [min]": parseFloat(document.getElementById("Tool-wear--min-").value),
    "Rotational speed [rpm]": parseFloat(document.getElementById("Rotational-speed--rpm-").value),
    "Process temperature [K]": parseFloat(document.getElementById("Process-temperature--K-").value),
    "Air temperature [K]": parseFloat(document.getElementById("Air-temperature--K-").value),
    "threshold": parseFloat(document.getElementById("Decision-threshold").value),
  };
}

async function updateTryItPrediction() {
  const box = document.getElementById("try-prediction");
  const explain = document.getElementById("try-explanation");
  const thresholdExplain = document.getElementById("threshold-explanation");
  try {
    // This is the one place the SPA asks the backend to run the model live.
    const result = await api("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectTryItPayload()),
    });
    const riskClassName = riskClass(result.risk);
    box.className = `prediction-box ${riskClassName}`;
    box.innerHTML = `
      <div class="prediction-mini-label">Failure probability</div>
      <div class="prob">${result.displayPercent}%</div>
      <div class="prediction-pill ${riskClassName}">&bull; ${result.risk}</div>
      <div class="prediction-note">Threshold is ${result.threshold.toFixed(2)}. ${result.inspectionFlag ? "This prediction is above it, so the model would flag it." : "This prediction is below it, so the model would leave it alone."}<br><br>${result.recommendation}</div>
    `;
    explain.innerHTML = result.lime && result.lime.length
      ? explanationRowsHtml(result.lime)
      : `<div class="explain-sub">Explanation unavailable for this prediction.</div>`;
    thresholdExplain.innerHTML = thresholdExplanationHtml(result, state.meta.thresholdInfo);
  } catch (error) {
    box.className = "prediction-box medium";
    box.innerHTML = `
      <div class="prediction-mini-label">Failure probability</div>
      <div class="prob">--</div>
      <div class="prediction-pill medium">Request failed</div>
      <div class="prediction-note">${escapeHtml(error.message || "Prediction could not be calculated.")}</div>
    `;
    explain.innerHTML = `<div class="explain-sub">${escapeHtml(error.message || "Explanation could not be calculated.")}</div>`;
    thresholdExplain.innerHTML = `<div class="explain-sub">${escapeHtml(error.message || "Threshold explanation unavailable.")}</div>`;
  }
}

function bindTryIt(meta) {
  // Keep the controls dumb: every interaction just updates the DOM and requests a new prediction.
  document.querySelectorAll('#try-it input[type="range"]').forEach((input) => {
    const label = document.getElementById(`${input.id}-value`);
    input.addEventListener("input", () => {
      label.textContent = input.value;
      updateTryItPrediction();
    });
  });
  const thresholdInput = document.getElementById("Decision-threshold");
  const thresholdLabel = document.getElementById("Decision-threshold-value");
  thresholdInput.addEventListener("input", () => {
    thresholdLabel.textContent = Number.parseFloat(thresholdInput.value).toFixed(2);
    updateTryItPrediction();
  });
  document.querySelectorAll(".grade-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".grade-btn").forEach((btn) => btn.classList.remove("is-active"));
      button.classList.add("is-active");
      updateTryItPrediction();
    });
  });
  document.querySelectorAll(".scenario-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const group = meta.scenarioGroups[button.dataset.scenarioType] || [];
      const preset = group[Number.parseInt(button.dataset.scenarioIndex, 10)]?.values;
      if (!preset) return;
      document.querySelectorAll(".scenario-btn").forEach((btn) => btn.classList.remove("is-active"));
      button.classList.add("is-active");
      applyTryItScenario(preset);
      updateTryItPrediction();
    });
  });
  updateTryItPrediction();
}

function renderHowItWorks() {
  // "How it works" mixes two sources from the notebook export:
  // 1. structured metrics/curves for this page
  // 2. saved figure files shown as supporting evidence
  const data = state.how;
  const figureCards = Object.entries(data.figurePaths || {}).map(([key, path]) => `
    <div class="figure-card">
      <div class="figure-title">${titleCase(key)}</div>
      <img src="${path}" alt="${titleCase(key)} figure">
    </div>
  `).join("");
  const modelRows = data.models.map((model) => `
    <tr>
      <td class="${model.winner ? "winner" : ""}">${model.name}</td>
      <td>${Math.round(model.recall * 100)}%</td>
      <td>${Math.round(model.precision * 100)}%</td>
      <td>${model.auc.toFixed(3)}</td>
      <td class="${model.winner ? "cost-positive" : ""}">&pound;${(model.cost / 1000).toFixed(1)}k</td>
    </tr>
  `).join("");

  const el = document.getElementById("how-it-works");
  el.innerHTML = `
    <div class="eyebrow">How it works</div>
    <h1 class="page-title">The model and how it makes decisions</h1>
    <p class="page-subtitle">A short technical summary. We tested three models, picked the best one, and chose a threshold based on the cost of getting it wrong.</p>
    <div class="divider"></div>

    <div class="how-grid">
      <div class="metric-card">
        <div class="label">Catches</div>
        <div class="value">${Math.round(data.headlineMetrics.recall * 100)}%</div>
        <div class="note">of real failures (recall)</div>
      </div>
      <div class="metric-card">
        <div class="label">Hit rate</div>
        <div class="value">${Math.round(data.headlineMetrics.precision * 100)}%</div>
        <div class="note">of flagged machines actually fail</div>
      </div>
      <div class="metric-card">
        <div class="label">Discrimination</div>
        <div class="value">${data.headlineMetrics.auc.toFixed(2)}</div>
        <div class="note">ROC AUC, higher is better</div>
      </div>
    </div>

    <div class="section-panel">
      <div class="section-header">Three models, one winner</div>
      <div class="section-body">
        <p class="page-subtitle" style="margin-bottom:18px; max-width:none;">We trained three models on 8,000 records and tested on 2,000. Random Forest catches the most failures for the lowest cost.</p>
        <table class="models-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Recall</th>
              <th>Precision</th>
              <th>AUC</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>${modelRows}</tbody>
        </table>
      </div>
    </div>

    <div class="section-panel">
      <div class="section-header">The threshold trade off</div>
      <div class="section-body">
        <p class="page-subtitle" style="margin-bottom:18px; max-width:none;">Move the line. Too low and you waste time on false alarms. Too high and you miss real failures. The chosen Random Forest operating threshold is around ${data.threshold.toFixed(2)}.</p>
        <div class="chart-wrap">
          <svg class="chart-svg" id="threshold-chart" viewBox="0 0 820 320"></svg>
        </div>
        <div class="chart-legend">
          <div class="legend-item"><span class="legend-line rf"></span>Random Forest</div>
          <div class="legend-item"><span class="legend-line lr"></span>Logistic Regression</div>
          <div class="legend-item"><span class="legend-line tab"></span>TabNet</div>
        </div>
        <div class="footnote">Cost assumes a missed failure costs &pound;1,000 in downtime, while a false alarm costs &pound;10 in wasted inspection time.</div>
      </div>
    </div>

    <div class="section-panel">
      <div class="section-header">Notebook Figures</div>
      <div class="section-body">
        <p class="page-subtitle" style="margin-bottom:18px; max-width:none;">These figures are loaded from the saved notebook artifacts, not hard-coded into the app.</p>
        <div class="figure-grid">${figureCards}</div>
      </div>
    </div>
  `;

  drawThresholdChart(data.thresholdCurves, data.threshold);
}

function drawThresholdChart(curves, threshold) {
  // The threshold chart is drawn inline with SVG so it remains lightweight and does not
  // need an extra charting library for one simple visualization.
  const svg = document.getElementById("threshold-chart");
  const width = 820;
  const height = 320;
  const margin = { top: 18, right: 12, bottom: 36, left: 26 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const line = (points, color) => {
    const d = points.map((point, index) => {
      const x = margin.left + point.threshold * innerW;
      const y = margin.top + (1 - point.value) * innerH;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" />`;
  };

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((tick) => {
    const x = margin.left + tick * innerW;
    return `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + innerH}" stroke="#26303b" stroke-dasharray="2 4" />`;
  }).join("");

  const axisLabels = [0, 0.25, 0.5, 0.75, 1].map((tick) => {
    const x = margin.left + tick * innerW;
    return `<text x="${x}" y="${height - 10}" fill="#8ea4b7" font-size="12" font-family="Consolas, monospace" text-anchor="middle">${tick.toFixed(2)}</text>`;
  }).join("");

  const thresholdX = margin.left + threshold * innerW;

  svg.innerHTML = `
    ${gridLines}
    ${line(curves["Random Forest"], "#67ccb0")}
    ${line(curves["Logistic Regression"], "#6f7a88")}
    ${line(curves["TabNet"], "#f4c056")}
    <line x1="${thresholdX}" y1="${margin.top}" x2="${thresholdX}" y2="${margin.top + innerH}" stroke="#ffffff" stroke-width="2" />
    <text x="${thresholdX}" y="${margin.top - 2}" fill="#ffffff" font-size="12" font-family="Consolas, monospace" text-anchor="middle">t = ${threshold.toFixed(2)}</text>
    ${axisLabels}
    <text x="${width / 2}" y="${height}" fill="#8ea4b7" font-size="12" font-family="Consolas, monospace" text-anchor="middle">decision threshold</text>
  `;
}

async function bootstrap() {
  // Startup loads all top-level views in parallel, then each view renders from cached state.
  const [overview, machines, meta, how] = await Promise.all([
    api("/api/overview"),
    api("/api/machines"),
    api("/api/try-it"),
    api("/api/how-it-works"),
  ]);
  state.overview = overview;
  state.machines = machines.machines;
  state.meta = meta;
  state.how = how;
  state.machineLabels = Object.fromEntries(
    state.machines.map((machine, index) => [machine.machineId, `Machine ${String(index + 1).padStart(2, "0")}`]),
  );

  renderOverview();
  renderMachineList();
  renderTryIt();
  renderHowItWorks();

  document.querySelectorAll(".nav-link").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
}

bootstrap().catch((error) => {
  // If initial boot fails, replace the page with the raw error so debugging stays obvious.
  console.error(error);
  document.body.innerHTML = `<pre style="padding:24px;color:#fff;background:#111;">${error.message}</pre>`;
});
