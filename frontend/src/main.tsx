import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import TimeAgo from 'javascript-time-ago'
import en from 'javascript-time-ago/locale/en'
import './index.css'
import App from './App.tsx'

// Initialize TimeAgo
TimeAgo.addDefaultLocale(en)

// Fancy console log
console.log(
  '%c🚀 DownLee %c\n%cDeveloped by Ribin Roy',
  'font-size: 24px; font-weight: bold; color: #06b6d4; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);',
  '',
  'font-size: 14px; color: #94a3b8; font-style: italic;'
)
console.log(
  '%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  'color: #06b6d4;'
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
