import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from flask import Flask, Response, abort, jsonify, request
from lime.lime_tabular import LimeTabularExplainer


ROOT_DIR = Path(__file__).resolve().parents[1]
ARTIFACTS_DIR = ROOT_DIR / "artifacts"
FIGURES_DIR = ARTIFACTS_DIR / "figures"
APP_PAYLOAD_PATH = ARTIFACTS_DIR / "app_payload.json"
MODEL_BUNDLE_PATH = ARTIFACTS_DIR / "model_bundle.joblib"
DATA_CACHE_PATH = ROOT_DIR / "data" / "ai4i_2020_cached.csv"

FEATURE_COLS = [
    "Type",
    "Air temperature [K]",
    "Process temperature [K]",
    "Rotational speed [rpm]",
    "Torque [Nm]",
    "Tool wear [min]",
]
MAX_JSON_BYTES = 4096

BASE_DIR = Path(__file__).resolve().parent
HTML_PATH = BASE_DIR / "presentation_app.html"
CSS_PATH = BASE_DIR / "presentation_app.css"
JS_PATH = BASE_DIR / "presentation_app.js"


def load_assets() -> tuple[dict[str, Any], dict[str, Any]]:
    # The notebook writes the UI payload and model bundle. The app only reads them.
    if not APP_PAYLOAD_PATH.exists() or not MODEL_BUNDLE_PATH.exists():
        missing = []
        if not APP_PAYLOAD_PATH.exists():
            missing.append(str(APP_PAYLOAD_PATH))
        if not MODEL_BUNDLE_PATH.exists():
            missing.append(str(MODEL_BUNDLE_PATH))
        raise FileNotFoundError(
            "Notebook artifacts are missing. Run notebooks/predictive_maintenance_pipeline.ipynb first. Missing: "
            + ", ".join(missing)
        )
    payload = json.loads(APP_PAYLOAD_PATH.read_text(encoding="utf-8"))
    bundle = joblib.load(MODEL_BUNDLE_PATH)
    return payload, bundle


def risk_band(probability: float, threshold: float) -> str:
    # Three fixed bands plus the model's own cost-optimal threshold as a lower review tier.
    # 0.70+ = HIGH: confident failure signal, act immediately.
    # 0.30–0.70 = MEDIUM: worth scheduling an inspection before next planned window.
    # threshold–0.30 = REVIEW: above the model's operating point but not high-confidence;
    #                           flag for a human to decide rather than auto-schedule.
    # below threshold = LOW: model says leave it alone for now.
    if probability >= 0.70:
        return "HIGH"
    if probability >= 0.30:
        return "MEDIUM"
    if probability >= threshold:
        return "REVIEW"
    return "LOW"


def recommendation(probability: float, threshold: float) -> str:
    # Mirrors the risk bands above with a plain-English action for the maintenance engineer.
    if probability >= 0.70:
        return "Inspect before next shift"
    if probability >= 0.30:
        return "Inspect during next planned window"
    if probability >= threshold:
        return "Flag for human review"
    return "Continue monitoring"


def inspection_flag(probability: float, threshold: float) -> bool:
    return probability >= threshold


APP_PAYLOAD, MODEL_BUNDLE = load_assets()


def build_threshold_info() -> dict[str, Any]:
    # The notebook currently tunes the operating point using a simple proxy cost model:
    # a missed failure is assumed to be far more expensive than an unnecessary inspection.
    metrics = APP_PAYLOAD.get("howItWorks", {}).get("headlineMetrics", {})
    flagged_count = len(APP_PAYLOAD.get("machines", {}).get("machines", []))
    return {
        "selectionMethod": "Default threshold chosen on validation data by minimizing estimated operational cost.",
        "costAssumptions": {
            "missedFailureGbp": 1000,
            "falseAlarmGbp": 10,
            "ratio": 100,
        },
        "defaultThreshold": float(MODEL_BUNDLE["threshold"]),
        "recall": float(metrics.get("recall", 0.0)),
        "precision": float(metrics.get("precision", 0.0)),
        "flaggedMachines": int(flagged_count),
    }


THRESHOLD_INFO = build_threshold_info()


# Fixed slider ranges make the demo easier to reason about than deriving them from
# dataset min/max. These are deliberately broader than the training distribution so
# users can push the machine into more obviously risky territory.
DEMO_FEATURE_BOUNDS: dict[str, dict[str, float | None]] = {
    "Type": {"min": None, "max": None},
    "Air temperature [K]": {"min": 294.0, "max": 306.0},
    "Process temperature [K]": {"min": 304.0, "max": 316.0},
    "Rotational speed [rpm]": {"min": 900.0, "max": 3000.0},
    "Torque [Nm]": {"min": 0.0, "max": 95.0},
    "Tool wear [min]": {"min": 0.0, "max": 320.0},
}


FALLBACK_SCENARIO_GROUPS: dict[str, list[dict[str, Any]]] = {
    "L": [
        {
            "label": "Healthy",
            "risk": "LOW",
            "probability": 0.01,
            "values": {
                "Type": "L",
                "Air temperature [K]": 300.0,
                "Process temperature [K]": 310.0,
                "Rotational speed [rpm]": 1500,
                "Torque [Nm]": 55.0,
                "Tool wear [min]": 180,
            },
        },
        {
            "label": "Medium risk",
            "risk": "MEDIUM",
            "probability": 0.60,
            "values": {
                "Type": "L",
                "Air temperature [K]": 300.0,
                "Process temperature [K]": 309.4,
                "Rotational speed [rpm]": 1420,
                "Torque [Nm]": 61.0,
                "Tool wear [min]": 225,
            },
        },
        {
            "label": "High risk",
            "risk": "HIGH",
            "probability": 0.98,
            "values": {
                "Type": "L",
                "Air temperature [K]": 302.6,
                "Process temperature [K]": 310.4,
                "Rotational speed [rpm]": 1365,
                "Torque [Nm]": 66.8,
                "Tool wear [min]": 80,
            },
        },
    ]
}

PROFILE_TARGETS: list[tuple[str, str, float]] = [
    ("Healthy", "LOW", 0.02),
    ("Medium risk", "MEDIUM", 0.50),
    ("High risk", "HIGH", 0.90),
]


def scenario_values_from_row(row: pd.Series) -> dict[str, Any]:
    return {
        "Type": str(row["Type"]),
        "Air temperature [K]": round(float(row["Air temperature [K]"]), 1),
        "Process temperature [K]": round(float(row["Process temperature [K]"]), 1),
        "Rotational speed [rpm]": int(round(float(row["Rotational speed [rpm]"]))),
        "Torque [Nm]": round(float(row["Torque [Nm]"]), 1),
        "Tool wear [min]": int(round(float(row["Tool wear [min]"]))),
    }


def build_demo_scenario_groups() -> dict[str, list[dict[str, Any]]]:
    if not DATA_CACHE_PATH.exists():
        return FALLBACK_SCENARIO_GROUPS

    scored = pd.read_csv(DATA_CACHE_PATH)[FEATURE_COLS].copy()
    probabilities = MODEL_BUNDLE["rf_model"].predict_proba(MODEL_BUNDLE["preprocessor"].transform(scored))[:, 1]
    threshold = float(MODEL_BUNDLE["threshold"])
    scored["probability"] = probabilities
    scored["riskBand"] = [risk_band(float(probability), threshold) for probability in probabilities]

    groups: dict[str, list[dict[str, Any]]] = {}
    for machine_type in sorted(scored["Type"].unique().tolist()):
        type_rows = scored[scored["Type"] == machine_type]
        profiles: list[dict[str, Any]] = []
        for label, band, target_probability in PROFILE_TARGETS:
            band_rows = type_rows[type_rows["riskBand"] == band].copy()
            if band_rows.empty:
                continue
            band_rows["distance"] = (band_rows["probability"] - target_probability).abs()
            chosen = band_rows.sort_values(["distance", "probability"], ascending=[True, False]).iloc[0]
            profiles.append(
                {
                    "label": label,
                    "risk": band,
                    "probability": round(float(chosen["probability"]), 3),
                    "values": scenario_values_from_row(chosen),
                }
            )
        if profiles:
            groups[str(machine_type)] = profiles

    return groups or FALLBACK_SCENARIO_GROUPS


DEMO_SCENARIO_GROUPS = build_demo_scenario_groups()


def model_feature_names() -> list[str]:
    cat_names = list(MODEL_BUNDLE["preprocessor"].named_transformers_["cat"].get_feature_names_out(["Type"]))
    return cat_names + [feature for feature in FEATURE_COLS if feature != "Type"]


def build_lime_explainer() -> LimeTabularExplainer | None:
    # Rebuild a local explainer from the cached dataset so live "Try it" predictions
    # can show the same style of local reasoning as the machine detail view.
    if not DATA_CACHE_PATH.exists():
        return None
    df = pd.read_csv(DATA_CACHE_PATH)
    training_features = df[FEATURE_COLS]
    training_prepared = MODEL_BUNDLE["preprocessor"].transform(training_features)
    return LimeTabularExplainer(
        training_data=training_prepared,
        feature_names=model_feature_names(),
        class_names=["No failure", "Failure"],
        mode="classification",
    )


def feature_key_from_rule(feature_rule: str) -> str | None:
    rule = feature_rule.lower()
    if "tool wear" in rule:
        return "Tool wear [min]"
    if "torque" in rule:
        return "Torque [Nm]"
    if "rotational speed" in rule or "speed" in rule:
        return "Rotational speed [rpm]"
    if "process temperature" in rule:
        return "Process temperature [K]"
    if "air temperature" in rule:
        return "Air temperature [K]"
    if "type_" in rule:
        return "Type"
    return None


def current_value_label(feature_key: str | None, row: dict[str, Any]) -> str:
    if feature_key is None:
        return "Current value unavailable"
    if feature_key == "Type":
        return f"Current grade: {row['Type']}"
    value = row[feature_key]
    if feature_key == "Tool wear [min]":
        return f"Current value: {int(round(float(value)))} min"
    if feature_key == "Rotational speed [rpm]":
        return f"Current value: {int(round(float(value)))} rpm"
    if feature_key == "Torque [Nm]":
        return f"Current value: {round(float(value), 1)} Nm"
    return f"Current value: {round(float(value), 1)} K"


LIME_EXPLAINER = build_lime_explainer()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_JSON_BYTES


def validate_predict_request(payload: Any) -> tuple[dict[str, Any], float]:
    if not isinstance(payload, dict):
        abort(400, description="JSON body must be an object.")

    expected_keys = set(FEATURE_COLS)
    missing_keys = [key for key in FEATURE_COLS if key not in payload]
    if missing_keys:
        abort(
            400,
            description="Payload is missing required feature fields: " + ", ".join(missing_keys) + ".",
        )

    row: dict[str, Any] = {"Type": payload["Type"]}
    type_options = MODEL_BUNDLE["meta"]["typeOptions"]
    if row["Type"] not in type_options:
        abort(400, description="Invalid machine type.")

    for feature in FEATURE_COLS:
        if feature == "Type":
            continue
        try:
            value = float(payload[feature])
        except (TypeError, ValueError):
            abort(400, description=f"Invalid numeric value for {feature}.")
        if not np.isfinite(value):
            abort(400, description=f"Non-finite value supplied for {feature}.")
        bounds = DEMO_FEATURE_BOUNDS[feature]
        lower = bounds["min"]
        upper = bounds["max"]
        if value < lower or value > upper:
            abort(400, description=f"{feature} is outside the accepted demo range.")
        row[feature] = value

    threshold = float(MODEL_BUNDLE["threshold"])
    if "threshold" in payload:
        try:
            threshold = float(payload["threshold"])
        except (TypeError, ValueError):
            abort(400, description="Invalid threshold value.")
        if not np.isfinite(threshold) or threshold <= 0 or threshold >= 1:
            abort(400, description="Threshold must be between 0 and 1.")
    return row, threshold


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(413)
@app.errorhandler(415)
def handle_client_error(error):
    code = getattr(error, "code", 400)
    description = getattr(error, "description", "Request rejected.")
    return jsonify({"error": description}), code


@app.errorhandler(FileNotFoundError)
def handle_missing_artifacts(error):
    return jsonify({"error": str(error)}), 500


@app.get("/")
def index() -> Response:
    return Response(HTML_PATH.read_text(encoding="utf-8"), mimetype="text/html")


@app.get("/presentation_app.css")
def app_css() -> Response:
    return Response(CSS_PATH.read_text(encoding="utf-8"), mimetype="text/css")


@app.get("/presentation_app.js")
def app_js() -> Response:
    return Response(JS_PATH.read_text(encoding="utf-8"), mimetype="application/javascript")


@app.get("/figures/<path:filename>")
def figures(filename: str) -> Response:
    path = FIGURES_DIR / filename
    if not path.exists():
        abort(404, description="Figure not found.")
    mime = "image/png" if path.suffix.lower() == ".png" else "application/octet-stream"
    return Response(path.read_bytes(), mimetype=mime)


@app.get("/api/health")
def health() -> Response:
    return jsonify({"status": "ok", "artifactPayload": str(APP_PAYLOAD_PATH)})


@app.get("/api/overview")
def overview() -> Response:
    return jsonify(APP_PAYLOAD["overview"])


@app.get("/api/machines")
def machines() -> Response:
    return jsonify(APP_PAYLOAD["machines"])


@app.get("/api/machines/<machine_id>")
def machine_detail(machine_id: str) -> Response:
    detail = APP_PAYLOAD["machineDetails"].get(machine_id)
    if detail is None:
        abort(404, description="Machine not found.")
    return jsonify(detail)


@app.get("/api/try-it")
def try_it_meta() -> Response:
    meta = dict(APP_PAYLOAD["tryIt"])
    meta["featureBounds"] = DEMO_FEATURE_BOUNDS
    meta["scenarioGroups"] = DEMO_SCENARIO_GROUPS
    default_group = DEMO_SCENARIO_GROUPS.get("L") or next(iter(DEMO_SCENARIO_GROUPS.values()), [])
    if default_group:
        meta["featureDefaults"] = dict(default_group[0]["values"])
    meta["thresholdInfo"] = THRESHOLD_INFO
    return jsonify(meta)


@app.post("/api/predict")
def predict() -> Response:
    payload = request.get_json(silent=True)
    row, threshold = validate_predict_request(payload)
    frame = pd.DataFrame([row], columns=FEATURE_COLS)
    prepared = MODEL_BUNDLE["preprocessor"].transform(frame)
    probability = float(MODEL_BUNDLE["rf_model"].predict_proba(prepared)[0, 1])
    lime_items: list[dict[str, Any]] = []
    if LIME_EXPLAINER is not None:
        lime_exp = LIME_EXPLAINER.explain_instance(prepared[0], MODEL_BUNDLE["rf_model"].predict_proba, num_features=5)
        for rule, contribution in lime_exp.as_list():
            feature_key = feature_key_from_rule(rule)
            lime_items.append(
                {
                    "feature_rule": rule,
                    "featureKey": feature_key,
                    "currentValueLabel": current_value_label(feature_key, row),
                    "contribution": float(contribution),
                }
            )
    return jsonify(
        {
            "failureProbability": probability,
            "displayPercent": round(probability * 100),
            "confidence": float(max(probability, 1 - probability)),
            "risk": risk_band(probability, threshold),
            "inspectionFlag": inspection_flag(probability, threshold),
            "recommendation": recommendation(probability, threshold),
            "threshold": threshold,
            "defaultThreshold": float(MODEL_BUNDLE["threshold"]),
            "lime": lime_items,
        }
    )


@app.get("/api/how-it-works")
def how_it_works() -> Response:
    return jsonify(APP_PAYLOAD["howItWorks"])


@app.get("/api/results-table")
def results_table() -> Response:
    return jsonify({"rows": APP_PAYLOAD["resultsTable"]})


@app.get("/api/top10")
def top10_table() -> Response:
    return jsonify({"rows": APP_PAYLOAD["top10Table"]})


if __name__ == "__main__":
    print(f"Serving notebook-backed presentation demo at http://127.0.0.1:5000 using {APP_PAYLOAD_PATH}")
    app.run(host="127.0.0.1", port=5000, debug=False)
