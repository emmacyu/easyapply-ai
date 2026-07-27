import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { JobsLayout } from './components/JobsLayout'
import { JobDetail } from './pages/JobDetail'
import { EmptyDetail } from './pages/EmptyDetail'
import { Profile } from './pages/Profile'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5000, retry: 1 },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/profile" element={<Profile />} />
          <Route element={<JobsLayout />}>
            <Route index element={<EmptyDetail />} />
            <Route path="jobs/:id" element={<JobDetail />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
