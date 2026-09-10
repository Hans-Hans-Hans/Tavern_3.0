import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import type { Page } from '@playwright/test';

/** Keep the real native-profile/avatar components without importing unrelated
 * settings editors into the isolated conference fixture. */
export async function routeVoiceAvatar(page: Page) {
  const source = await readFile('app/community-settings.tsx', 'utf8');
  const start = source.indexOf('function useCommunityRefresh()'), end = source.indexOf('export function ImageEditor(');
  if (start < 0 || end <= start) throw new Error('The current avatar component boundary must be reviewed.');
  const body = ts.transpileModule(`import React from '/tests/browser/fixtures/voice-react.ts';const {useEffect,useState}=React;
    import {getMatrixClient,onMatrixUpdate} from '/lib/matrix.ts';
    import {readMemberProfile} from '/lib/community.ts';
    import {acquireProfileImage} from '/lib/profile-image-cache.ts';
    ${source.slice(start, end)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  await page.route(url => url.pathname === '/app/community-settings.tsx', route => route.fulfill({ contentType: 'text/javascript', body }));
}
