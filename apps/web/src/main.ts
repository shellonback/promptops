import { ApplicationRef } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { isDetachedWindow } from './app/detached/detached-window';
import { LOCAL_MODE, LOCAL_SESSION_TOKEN } from './app/core/local-mode';
import { applyUiLanguage, uiLocale } from './app/core/helper/ui-locale';

// Local mode has no sign-in: a placeholder token lets the app's session checks
// pass. It never leaves the device (see core/local-mode.ts).
if (LOCAL_MODE && localStorage.getItem('token') !== LOCAL_SESSION_TOKEN) {
  localStorage.setItem('token', LOCAL_SESSION_TOKEN);
}

// WebKitGTK (Linux) often skips backdrop-filter: glass surfaces need an opaque fallback.
if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) {
  document.documentElement.setAttribute('data-po-os', 'linux');
}
import 'iconify-icon';
import { registerOfflineIcons } from './app/core/icons/offline-icons';

// Icons ship with the app: no request to an icon service.
registerOfflineIcons();

console.info('PromptOps (open source) · https://github.com/shellonback/promptops');

// Language and direction (Arabic is right to left) before the first paint,
// then on every language change.
applyUiLanguage(uiLocale());
function followUiLanguage(app: ApplicationRef): void {
  app.injector.get(TranslateService).onLangChange.subscribe(({ lang }) => applyUiLanguage(lang));
}

// Detached Tauri window (Floor plan): a minimal shell, loaded only when needed.
if (isDetachedWindow()) {
  Promise.all([import('./app/detached/detached-shell.component'), import('./app/detached/detached.config')])
    .then(([shell, config]) => bootstrapApplication(shell.DetachedShellComponent, config.detachedConfig))
    .then(followUiLanguage)
    .catch((err) => console.error(err));
} else {
  bootstrapApplication(AppComponent, appConfig)
    .then(followUiLanguage)
    .catch((err) => console.error(err));
}
