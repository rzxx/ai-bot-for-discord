# Languages and speech

Choose a language in setup. It selects the interface, runtime messages, agent instructions, and speech defaults together. English is the default; Russian is also included. Missing translations fall back to English.

Each locale has its own conversation guidance and speech tuning. A session receives the instructions for its locale, rather than a prompt containing rules for every supported language. Tool names and protocol fields stay stable across locales.

## Change the language

Open `bun run configure` and select a language. To open setup directly in Russian:

```sh
bun run configure --locale ru
```

The form updates the matching speech defaults when you change languages. Use `--locale en` to switch back. After saving a different speech stack, run `bun run setup:speech` and restart the bot.

For manual configuration, changing `locale` alone changes the interface and agent instructions. Saved `speechLanguage`, `sttEngine`, `voice`, and pronunciation settings remain explicit overrides: update them too, or remove those fields to use the new locale's defaults.

Existing installations keep their speech choices. A configuration that predates `locale` is recognized from its existing language and speech settings.

## English

The English setup uses Whisper for recognition and Silero for synthesis. The default voice is `en_0`; use `/voice` to choose another voice supported by the installed model.

Keep `responseLanguage: "auto"` to follow the current speaker. To keep replies in one language, set a language name or tag. Speech models need to support the language you want to hear.

Local conversation hints recognize short acknowledgements, direct questions, connection checks, and explicit stops addressed to the bot.

## Русский

Выберите русский язык через `bun run configure --locale ru` и сохраните форму. Затем выполните:

```sh
bun run setup:speech
bun start
```

Чтобы сразу открыть настройку на русском, используйте `bun run configure --locale ru`. Выбор сохраняется при отправке формы. Переключение языка сохраняет ваши собственные настройки произношения.

Для распознавания используется GigaAM, для озвучки — Silero. Голос по умолчанию — `eugene`; изменить его можно командой `/voice`. Если нужен Whisper, установите его через `bun run setup:speech --whisper`, укажите `"sttEngine": "whisper"` и перезапустите бота.

Русская локализация включает интерфейс, сообщения, инструкции модели и подсказки для ведения беседы. Инструкции учитывают речь без пунктуации, русские падежи, букву «ё» и произношение иностранных слов. Короткие реплики и проверки связи обрабатываются с учётом русского языка.

Командой `/name` можно задать имя и произношение. Для ударения Silero поддерживает `+` перед ударной гласной, например `Ал+ёна`. Частые замены можно хранить в словаре `pronunciations`:

```json
{
  "pronunciations": {
    "Discord": "Дискорд"
  }
}
```

`responseLanguage: "auto"` позволяет отвечать на языке собеседника. Чтобы предпочитать русский независимо от входящей реплики, задайте `"responseLanguage": "ru"`. Тон и привычки общения настраиваются через `additionalInstructions`.

## Tune the experience

Start with real speech before changing thresholds: a short question, a correction, overlapping speakers, and an interruption during playback. Check recognition and pronunciation separately from the model's answer.

| Setting | What it changes |
| --- | --- |
| `locale` | Interface, messages, and agent instruction locale |
| `speechLanguage` | Language used by recognition and local speech hints |
| `responseLanguage` | Preferred reply language, or `auto` |
| `voice` | Voice ID for the selected speech adapter |
| `pronunciations` | Word/name pronunciation overrides |
| `additionalInstructions` | Conversation preferences such as tone and brevity |

Restart after changing these settings so a session has one consistent instruction prefix. Different recognition and synthesis models have different strengths; changing prompt language alone does not change their language support.

## Add another locale or speech stack

A locale supplies translated product messages, agent instructions, and language-specific conversation hints. Provide English fallback for missing entries, keep protocol keys unchanged, and test the locale without loading instructions for other languages into the same session.

For a new speech backend, implement the [speech adapter](adapters.md#speech). Test recognition, pronunciation, timing, and requested tool actions with speakers of the target language. Search ranking and local tool-intent checks also need language-specific evaluation.

The included speech integrations use [Whisper](https://github.com/ggml-org/whisper.cpp), [GigaAM](https://github.com/salute-developers/GigaAM) through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), and [Silero](https://github.com/snakers4/silero-models). Weights are downloaded separately and retain their upstream licenses.
