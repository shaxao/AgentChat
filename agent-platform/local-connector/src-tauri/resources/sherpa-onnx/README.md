This directory is the Tauri bundle resource slot for offline speech-to-text.

Expected layout for an install-ready build:

resources/sherpa-onnx/bin/sherpa-onnx-offline-parallel.exe
resources/sherpa-onnx/bin/onnxruntime.dll

At runtime AutoCode also checks the user data directory:

%LOCALAPPDATA%/AutoCodeLocalConnector/stt/sherpa-onnx/bin
%LOCALAPPDATA%/AutoCodeLocalConnector/stt/sherpa-onnx/models

Model files are intentionally not bundled by default. Users install the model
they want from the voice module; downloaded models are stored under AppData and
become available immediately after download.
