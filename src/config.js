// 빌드할 때 tools/build.mjs 가 아래 한 줄을 통째로 갈아끼운다.
// 값이 비어 있으면 멀티플레이 기능이 화면에 나타나지 않는다 (오프라인 솔로 게임).
globalThis.TWConfig = { url: '', key: '' } /*TWCONFIG*/
