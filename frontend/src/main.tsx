import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import TimeAgo from 'javascript-time-ago'
import en from 'javascript-time-ago/locale/en'
import './index.css'
import App from './App.tsx'
import { queryClient } from './lib/queryClient'

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
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  </StrictMode>,
)
