"""resolve_whisper_model のローカル解決テスト（R4 / Issue #8）。実ダウンロードはしない。

+ resolve_whisper_runtime の優先順位（settings明示 > 環境変数 > "auto"、Issue #12）
+ friendly_model_init_error の設定エラー変換
"""

from pathlib import Path

import pytest

from podcast_prep.transcribe import (
    friendly_model_init_error,
    resolve_whisper_model,
    resolve_whisper_runtime,
)


def _use_tmp_data_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("PODCAST_PREP_DATA_DIR", str(tmp_path))
    # 既定の local_only=True 挙動をテスト前提にする（環境の影響を排除）
    monkeypatch.delenv("PODCAST_PREP_WHISPER_LOCAL_ONLY", raising=False)
    return tmp_path


def test_existing_path_returned_as_is(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    model_dir = tmp_path / "my-ct2-model"
    model_dir.mkdir()
    assert resolve_whisper_model(str(model_dir), {}) == str(model_dir)


def test_model_name_resolves_under_models_dir(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    placed = tmp_path / "models" / "faster-whisper-medium"
    placed.mkdir(parents=True)
    resolved = resolve_whisper_model("medium", {})
    # data_dir() は resolve() されるため、パス同一性で比較する
    assert Path(resolved).resolve() == placed.resolve()


def test_settings_fallback_used_when_ref_is_none(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    placed = tmp_path / "models" / "faster-whisper-small"
    placed.mkdir(parents=True)
    resolved = resolve_whisper_model(None, {"whisper_model": "small"})
    assert Path(resolved).resolve() == placed.resolve()


def test_missing_model_raises_with_setup_guidance(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    with pytest.raises(RuntimeError) as excinfo:
        resolve_whisper_model("medium", {})
    message = str(excinfo.value)
    # エラーではなくセットアップ手順への誘導になっていること（R4受け入れ条件）
    assert "fetch_whisper_model" in message
    assert "README" in message


def test_local_only_zero_passes_name_through(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    monkeypatch.setenv("PODCAST_PREP_WHISPER_LOCAL_ONLY", "0")
    # オンライン許可時はモデル名がそのまま faster-whisper に渡る（RuntimeErrorにならない）
    assert resolve_whisper_model("medium", {}) == "medium"


# ---------------------------------------------------------------- resolve_whisper_runtime（Issue #12）


def _clear_runtime_env(monkeypatch):
    monkeypatch.delenv("PODCAST_PREP_WHISPER_DEVICE", raising=False)
    monkeypatch.delenv("PODCAST_PREP_WHISPER_COMPUTE_TYPE", raising=False)


def test_runtime_defaults_to_auto(monkeypatch):
    _clear_runtime_env(monkeypatch)
    assert resolve_whisper_runtime({}) == {"device": "auto", "compute_type": "auto"}


def test_runtime_settings_explicit_beats_env(monkeypatch):
    _clear_runtime_env(monkeypatch)
    monkeypatch.setenv("PODCAST_PREP_WHISPER_COMPUTE_TYPE", "float32")
    monkeypatch.setenv("PODCAST_PREP_WHISPER_DEVICE", "cuda")
    runtime = resolve_whisper_runtime(
        {"whisper_compute_type": "int8", "whisper_device": "cpu"}
    )
    assert runtime == {"device": "cpu", "compute_type": "int8"}  # settings が最優先


def test_runtime_env_used_when_settings_auto(monkeypatch):
    _clear_runtime_env(monkeypatch)
    monkeypatch.setenv("PODCAST_PREP_WHISPER_COMPUTE_TYPE", "int8")
    runtime = resolve_whisper_runtime(
        {"whisper_compute_type": "auto", "whisper_device": "auto"}
    )
    assert runtime == {"device": "auto", "compute_type": "int8"}


def test_runtime_keys_resolve_independently(monkeypatch):
    _clear_runtime_env(monkeypatch)
    monkeypatch.setenv("PODCAST_PREP_WHISPER_DEVICE", "cpu")
    runtime = resolve_whisper_runtime({"whisper_compute_type": "float32"})
    # compute_type は settings 明示、device は settings 欠損 → env
    assert runtime == {"device": "cpu", "compute_type": "float32"}


@pytest.mark.parametrize("junk", [None, "", "  "])
def test_runtime_blank_settings_treated_as_auto(monkeypatch, junk):
    _clear_runtime_env(monkeypatch)
    runtime = resolve_whisper_runtime(
        {"whisper_compute_type": junk, "whisper_device": junk}
    )
    assert runtime == {"device": "auto", "compute_type": "auto"}


def test_runtime_blank_env_treated_as_auto(monkeypatch):
    _clear_runtime_env(monkeypatch)
    monkeypatch.setenv("PODCAST_PREP_WHISPER_COMPUTE_TYPE", "   ")
    assert resolve_whisper_runtime({})["compute_type"] == "auto"


# ---------------------------------------------------------------- friendly_model_init_error


def test_friendly_error_for_float16_on_cpu():
    exc = ValueError(
        "Requested float16 compute type, but the target device or backend "
        "do not support efficient float16 computation."
    )
    message = friendly_model_init_error(exc, "auto", "float16")
    assert message is not None
    assert "設定エラー" in message
    assert "float16はCUDA環境専用です" in message
    assert "文字起こし設定" in message


def test_friendly_error_for_other_compute_type_mentions_value():
    exc = ValueError("Requested int8_float16 compute type, but ... not supported")
    message = friendly_model_init_error(exc, "cpu", "int8_float16")
    assert message is not None
    assert "int8_float16" in message
    assert "設定エラー" in message


def test_friendly_error_ignores_unrelated_value_error():
    # compute type と無関係な失敗（モデル破損等）は変換しない → None
    assert friendly_model_init_error(ValueError("model file corrupt"), "auto", "int8") is None
