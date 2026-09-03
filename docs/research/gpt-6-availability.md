# GPT-6 availability: OpenAI, API, ChatGPT, and Pi

**Checked:** 2026-09-03 20:35 UTC

Local Pi citations below are package-relative paths inside the installed npm packages; the host-specific installation prefix is intentionally omitted.

## Answer

Yes. OpenAI has officially documented and announced **GPT-6 Astra**. The official product name is GPT-6 Astra and the only GPT-6 API model ID currently listed in OpenAI's public model documentation is **`gpt-6-astra`**; the documentation does not list a generic `gpt-6` ID or any other GPT-6 variant. [OpenAI model catalog](https://developers.openai.com/api/docs/models.md) · [GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra.md)

This is an **announcement plus a staged rollout**, not evidence of universal availability. OpenAI says GPT-6 Astra is “rolling out today” to enterprises in its Trusted Access Program, while API access and access through ChatGPT Plus, Pro, Business, and Enterprise plans are “coming in the coming days.” Therefore, the public documentation confirms the model and intended surfaces, but does not establish that an arbitrary API organization or ChatGPT account can use it yet. [OpenAI model catalog](https://developers.openai.com/api/docs/models.md) · [GPT-6 Astra guide](https://developers.openai.com/api/docs/guides/latest-model.md)

## Announcement, rollout, and availability are separate

| Question | Current evidence |
|---|---|
| Has OpenAI officially named a GPT-6 model? | **Yes: GPT-6 Astra.** OpenAI's model catalog, dedicated model page, and usage guide all name it. [Model catalog](https://developers.openai.com/api/docs/models.md) · [Model page](https://developers.openai.com/api/docs/models/gpt-6-astra.md) |
| Is rollout underway? | **Yes, but narrowly.** OpenAI says rollout is occurring for enterprises in the Trusted Access Program. [Model page](https://developers.openai.com/api/docs/models/gpt-6-astra.md) |
| Is general API access available now? | **Not according to the rollout wording.** OpenAI says API access is coming “in the coming days.” Its guide nevertheless documents how to call the model once the caller has access. [Model catalog](https://developers.openai.com/api/docs/models.md) · [Usage guide](https://developers.openai.com/api/docs/guides/latest-model.md) |
| Is it generally available in ChatGPT now? | **Not according to the rollout wording.** Plus, Pro, Business, and Enterprise plan access is also described as coming “in the coming days.” [Model catalog](https://developers.openai.com/api/docs/models.md) |
| Does today's Trusted Access rollout mean API, ChatGPT, or both? | **The accessible public wording does not say clearly.** It names the Trusted Access cohort, then separately says API and the listed plans are coming later; this research does not infer a surface for the cohort. [Model page](https://developers.openai.com/api/docs/models/gpt-6-astra.md) |

The dedicated API page lists both `v1/responses` and `v1/chat/completions` as supported endpoints. The migration guide adds an important limitation: GPT-6 Astra supports Chat Completions, but tool calling requires the Responses API. These are documented API capabilities, not proof that every account is already entitled to use the model. [GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra.md) · [GPT-6 Astra guide](https://developers.openai.com/api/docs/guides/latest-model.md#migration-quickstart)

## Official model IDs

OpenAI currently documents exactly one GPT-6 model ID:

- **`gpt-6-astra`** — listed as the model ID, default snapshot, and sole entry under snapshots and aliases. No dated snapshot is publicly listed. [GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra.md)

Names such as `gpt-6`, `gpt-6-pro`, `gpt-6-mini`, and `gpt-6-codex` should not be treated as valid model IDs: they do not appear in OpenAI's current public model catalog. [OpenAI model catalog](https://developers.openai.com/api/docs/models.md)

## Why it may not appear in Pi's model selector

Pi's model selector is not a live mirror of OpenAI's `/v1/models` response. Pi maintains tool-capable built-in provider catalogs, overlays newer entries from Pi's own remote catalogs, and exposes catalog refresh through `pi update --models`. `<installed @earendil-works/pi-coding-agent>/README.md` (“Providers & Models” and “Pi Packages”) · `<installed @earendil-works/pi-coding-agent>/dist/core/remote-catalog-provider.js`

At the time checked:

- Installed Pi is version **0.84.4**. `<installed @earendil-works/pi-coding-agent>/package.json`
- Neither installed static provider catalog contains `gpt-6-astra`. `<installed @earendil-works/pi-ai>/dist/providers/data/openai.json` · `<installed @earendil-works/pi-ai>/dist/providers/data/openai-codex.json`
- Pi's current remote `openai` and `openai-codex` catalogs also omit `gpt-6-astra`. [Pi `openai` catalog](https://pi.dev/api/models/providers/openai) · [Pi `openai-codex` catalog](https://pi.dev/api/models/providers/openai-codex)

That catalog lag is sufficient to explain why GPT-6 Astra is absent even though OpenAI has documented it. A second, independent reason can be authentication or entitlement: Pi says models without configured provider authentication remain unavailable in `/model` and `--list-models`, while OpenAI's staged rollout means a valid credential still may not have GPT-6 Astra access yet. `<installed @earendil-works/pi-coding-agent>/docs/models.md` (“Provider Configuration”) · [OpenAI rollout wording](https://developers.openai.com/api/docs/models/gpt-6-astra.md)

ChatGPT product access and Pi's OpenAI Codex provider are also distinct catalog and access paths. Pi documents ChatGPT subscription login under its `openai-codex` provider, while direct OpenAI API-key use is the `openai` provider; availability in the ChatGPT web product therefore does not by itself add a model to either Pi catalog. `<installed @earendil-works/pi-coding-agent>/README.md` (“Providers & Models”) · `<installed @earendil-works/pi-ai>/dist/providers/data/openai-codex.json`

## Practical next step

1. Wait until OpenAI says the relevant API organization or ChatGPT plan has access; the announcement currently says broader access is still coming. [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6-astra.md)
2. Refresh Pi's catalogs with `pi update --models`, restart Pi if needed, and check `pi --list-models gpt-6-astra` or `/model`. Pi explicitly documents automatic catalog refresh and the forced refresh command. `<installed @earendil-works/pi-coding-agent>/README.md` (“Providers & Models”)
3. If OpenAI API access is confirmed but Pi's catalog still has no entry, use Pi's documented `~/.pi/agent/models.json` custom-model mechanism under the built-in `openai` provider, selecting `api: "openai-responses"` and ID `gpt-6-astra`, or update Pi when its maintained catalog adds the model. Do not guess unsupported IDs. Pi documents that custom models merge into built-in providers and that the Responses API is supported; OpenAI requires Responses for GPT-6 Astra tool calling. `<installed @earendil-works/pi-coding-agent>/docs/models.md` (“Supported APIs” and “Overriding Built-in Providers”) · [OpenAI migration guide](https://developers.openai.com/api/docs/guides/latest-model.md#migration-quickstart)

A manual entry should be treated as a temporary compatibility test, not proof of access or complete Pi support. Pi metadata controls context limits, reasoning levels, pricing, and compatibility behavior, so the maintained catalog is safer than inventing incomplete metadata. `<installed @earendil-works/pi-coding-agent>/docs/models.md` (“Model Configuration”)

## Evidence limitations and access failures

- An unauthenticated request to `https://api.openai.com/v1/models` returned HTTP 401 (“Missing bearer authentication”). No credential was read or sent, so this research could not verify account-specific model visibility through the Models API. [OpenAI Models API endpoint](https://api.openai.com/v1/models)
- OpenAI's linked launch article, `https://openai.com/index/gpt-6-astra/`, returned HTTP 403 to direct retrieval in this environment. The consequential availability findings above therefore rely on OpenAI's accessible official developer documentation, not on an inferred article body. [OpenAI launch-article URL](https://openai.com/index/gpt-6-astra/)
- OpenAI Help Center model release notes also returned HTTP 403 to direct retrieval. They were not used as evidence. [OpenAI model release notes](https://help.openai.com/en/articles/9624314-model-release-notes)
- The public rollout text uses relative timing (“today” and “in the coming days”) and exposes no publication timestamp in the accessible Markdown pages. This report preserves that wording and records its own check time rather than assigning an unsupported calendar deadline. [OpenAI model catalog](https://developers.openai.com/api/docs/models.md)
