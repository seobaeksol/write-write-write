# 내장 모델

이 앱은 Alibaba Cloud의 [Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)를 사용합니다. GGUF 변환 및 Q4_K_M 양자화 파일은 bartowski가 제공한 [LM Studio Community 배포본](https://huggingface.co/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF)이며, 이 프로젝트에서는 해당 파일을 변경하지 않습니다. LM Studio 프로그램을 별도로 설치할 필요는 없습니다.

- 파일: `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` (2,497,280,448 bytes, 약 2.50 GB)
- 고정된 배포 커밋: `4edb920b6f14e3b9284d4502a6485103d72cde05`
- SHA-256: `8cdb57cbb880d313736a9bc4e3d3d2485f145b5e19cf33783746e753e82641fc`
- 라이선스: Apache License 2.0, Copyright 2024 Alibaba Cloud. 원문은 [LICENSE-Qwen.txt](LICENSE-Qwen.txt)에 포함했습니다. [원문 출처](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/cdbee75f17c01a7cc42f958dc650907174af0554/LICENSE).

개발 또는 배포 빌드 전에 프로젝트 루트에서 한 번 실행합니다.

```sh
node scripts/setup-model.mjs
```

다운로드는 임시 `.part` 파일에 기록하고 크기와 SHA-256이 일치할 때만 모델로 저장합니다. 이미 올바른 파일이 있으면 다시 다운로드하지 않습니다. 배포 패키지는 이 모델과 라이선스를 함께 포함해야 합니다. 앱 실행 중에는 모델을 다운로드하지 않습니다.

네트워크 요청 없이 배포 준비 여부만 확인하려면 다음 명령을 사용합니다.

```sh
node scripts/setup-model.mjs --check
```

2.50 GB의 모델 가중치와 별도로 추론에 필요한 메모리가 있습니다. 작은 로컬 모델이므로 피드백의 품질은 대형 온라인 모델과 다를 수 있습니다.
