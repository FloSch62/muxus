import '@azurity/pure-nerd-font/pure-nerd-font.css';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { initializeWailsDesktop } from './desktop-wails.js';

await initializeWailsDesktop();
await import('./bootstrap.js');
