import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Spec 0003: reducedMotion="user" makes every motion/react animation drop its
        transform and keep only opacity, so a row still appears but does not travel.
        It cannot be done per component and it cannot be done with the Tailwind
        `motion-safe:` variant, which only gates CSS transitions. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
)