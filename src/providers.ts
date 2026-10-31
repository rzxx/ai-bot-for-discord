import { t } from './locale';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { type Config, ROOT } from './config';
import { CredentialStore } from './platform';
import { discovery, listModels, login, PlanAuth } from './auth';
import { PlusBrain, type Brain } from './llm';
import { SpeechRuntime, type SpeechAdapter } from './speech';

export interface InferenceModel {
  slug: string;
  display_name: string;
  context_window?: number;
  supported_reasoning_levels?: { effort: string }[];
}

/** A provider owns authentication, model discovery and construction of its Brain. */
export interface InferenceProvider {
  models(): Promise<InferenceModel[]>;
  login?(): Promise<void>;
  logout?(): Promise<void>;
  createBrain(): Brain;
}

export interface AdapterModule {
  createInferenceProvider?(config: Config, store: CredentialStore): InferenceProvider | Promise<InferenceProvider>;
  createSpeechAdapter?(config: Config, onFailure: (error: Error) => void): SpeechAdapter | Promise<SpeechAdapter>;
}

async function loadAdapter(path: string): Promise<AdapterModule> {
  // This is explicitly configured local executable code, never a model/tool-selected module.
  return import(pathToFileURL(resolve(ROOT, path)).href);
}

export async function createInferenceProvider(config: Config, store: CredentialStore): Promise<InferenceProvider> {
  if (config.inferenceAdapter) {
    const module = await loadAdapter(config.inferenceAdapter);
    if (!module.createInferenceProvider) throw new Error(t("Inference adapter must export createInferenceProvider."));
    return module.createInferenceProvider(config, store);
  }
  const auth = new PlanAuth(store);
  return {
    models: () => listModels(auth),
    login: async () => { await login(store); },
    logout: async () => {
      const credentials = await store.read();
      if (credentials.account?.refreshToken) {
        const d = await discovery();
        if (!d.revocation_endpoint || new URL(d.revocation_endpoint).origin !== 'https://auth.openai.com') throw new Error(t("No safe session revocation endpoint."));
        const response = await fetch(d.revocation_endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: credentials.account.refreshToken, token_type_hint: 'refresh_token', client_id: credentials.account.clientId }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(t("Could not confirm session revocation. Retry or disconnect the app in ChatGPT settings."));
      }
      await store.update(value => ({ ...value, account: undefined }));
    },
    createBrain: () => new PlusBrain(auth, config),
  };
}

export async function createSpeechAdapter(config: Config, onFailure: (error: Error) => void): Promise<SpeechAdapter> {
  if (!config.speechAdapter) return new SpeechRuntime(config, onFailure);
  const module = await loadAdapter(config.speechAdapter);
  if (!module.createSpeechAdapter) throw new Error(t("Speech adapter must export createSpeechAdapter."));
  return module.createSpeechAdapter(config, onFailure);
}
