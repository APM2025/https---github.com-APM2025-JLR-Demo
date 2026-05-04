import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from flask import Flask, Response, abort, jsonify, request


ROOT_DIR = Path(__file__).resolve().parents[1]
ARTIFACTS_DIR = ROOT_DIR / "artifacts"
FIGURES_DIR = ARTIFACTS_DIR / "figures"
APP_PAYLOAD_PATH = ARTIFACTS_DIR / "app_payload.json"
MODEL_BUNDLE_PATH = ARTIFACTS_DIR / "model_bundle.joblib"

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

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_JSON_BYTES


def validate_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        abort(400, description="JSON body must be an object.")

    expected_keys = set(FEATURE_COLS)
    if set(payload.keys()) != expected_keys:
        abort(400, description="Payload must contain exactly the expected feature fields.")

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
        bounds = MODEL_BUNDLE["meta"]["featureBounds"][feature]
        lower = bounds["min"]
        upper = bounds["max"]
        # Allow 10% outside the training range so demo sliders can reach edge cases
        # without the API rejecting them. The floor of 1.0 handles narrow-range features.
        margin = max((upper - lower) * 0.10, 1.0)
        if value < lower - margin or value > upper + margin:
            abort(400, description=f"{feature} is outside the accepted demo range.")
        row[feature] = value
    return row


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
    return jsonify(APP_PAYLOAD["tryIt"])


@app.post("/api/predict")
def predict() -> Response:
    payload = request.get_json(silent=True)
    row = validate_payload(payload)
    frame = pd.DataFrame([row], columns=FEATURE_COLS)
    prepared = MODEL_BUNDLE["preprocessor"].transform(frame)
    probability = float(MODEL_BUNDLE["rf_model"].predict_proba(prepared)[0, 1])
    return jsonify(
        {
            "failureProbability": probability,
            "displayPercent": round(probability * 100),
            "confidence": float(max(probability, 1 - probability)),
            "risk": risk_band(probability, MODEL_BUNDLE["threshold"]),
            "inspectionFlag": inspection_flag(probability, MODEL_BUNDLE["threshold"]),
            "recommendation": recommendation(probability, MODEL_BUNDLE["threshold"]),
            "threshold": MODEL_BUNDLE["threshold"],
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
