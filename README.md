# Predictive Maintenance Demo

## Structure

- `app/`: Flask demo app and frontend assets.
- `notebooks/`: the main notebook. This is the primary workflow.
- `artifacts/`: generated JSON, model bundle, and figures.
- `data/`: cached AI4I dataset used by the notebook pipeline.

## How To Run

1. Open `notebooks/predictive_maintenance_pipeline.ipynb`.
2. Run the notebook from top to bottom.
3. The final notebook cell exports everything the app needs into `artifacts/`.
4. Start the app:
   - from the project root:
     - `powershell -ExecutionPolicy Bypass -File .\app\run_demo.ps1`
   - or from inside `app/`:
     - `.\run_demo.ps1`
5. Open `http://127.0.0.1:5000`

## Workflow

- The notebook is the source of truth for the model training, figures, and exported app data.
- The app does not retrain anything. It only loads:

- `artifacts/app_payload.json`
- `artifacts/model_bundle.joblib`

- If the notebook changes, rerun the notebook before starting the app again.
