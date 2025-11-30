import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import TimeAgo from 'javascript-time-ago'
import en from 'javascript-time-ago/locale/en'
import './index.css'
import App from './App.tsx'

// Initialize TimeAgo
TimeAgo.addDefaultLocale(en)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
