import { Suspense, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { WatercolorReveal } from './WatercolorReveal'
import img1A from '../img/1A_Story_Intro.webp'
import img1B from '../img/1B_Story_Intro.webp'
import img1C from '../img/1C_Story_Intro.webp'
import './App.css'

const IMAGES = [
  { url: img1A, label: '1A Story Intro' },
  { url: img1B, label: '1B Story Intro' },
  { url: img1C, label: '1C Story Intro' },
]

const DEFAULT_CONFIG = {
  brushSize: 0.28,
  brushOpacity: 0.7,
  noiseScale: 5.0,
  displacement: 0.05,
  edgeSoftness: 0.5,
  settleSpeed: 0.35,
  wetHalo: 2.2,
}

export default function App() {
  const captureMode =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('capture') === '1'
  const [imageUrl, setImageUrl] = useState(IMAGES[0].url)
  const [resetCounter, setResetCounter] = useState(0)
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [showControls, setShowControls] = useState(!captureMode)
  const fileInputRef = useRef(null)

  const handleFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl)
    setImageUrl(URL.createObjectURL(file))
  }

  const resetMask = () => setResetCounter((c) => c + 1)
  const setParam = (k, v) => setConfig((c) => ({ ...c, [k]: v }))

  return (
    <div className={`app${captureMode ? ' capture' : ''}`}>
      <div className="landscape-stage">
        <Canvas dpr={[1, 2]} gl={{ antialias: false, alpha: false }}>
          <Suspense fallback={null}>
            <WatercolorReveal
              // Re-mount on image change or manual reset so the FBO is wiped.
              key={`${imageUrl}-${resetCounter}-${captureMode}`}
              imageUrl={imageUrl}
              captureMode={captureMode}
              {...config}
            />
          </Suspense>
        </Canvas>

        {!captureMode && <div className="hint">Move your cursor to reveal</div>}

        {!captureMode && (
          <button
            className="toggle"
            onClick={() => setShowControls((s) => !s)}
            title="Toggle controls"
          >
            {showControls ? 'Hide' : 'Show'} controls
          </button>
        )}

        {!captureMode && showControls && (
          <div className="controls">
            <h1>Watercolor Reveal</h1>
            <p className="subtitle">WebGL · React Three Fiber</p>

            <div className="image-picker">
              {IMAGES.map((img) => (
                <button
                  key={img.url}
                  className={imageUrl === img.url ? 'active' : ''}
                  onClick={() => setImageUrl(img.url)}
                  style={{ backgroundImage: `url(${img.url})` }}
                  title={img.label}
                  aria-label={img.label}
                />
              ))}
            </div>

            <div className="row">
              <button onClick={() => fileInputRef.current?.click()}>
                Load image
              </button>
              <button onClick={resetMask}>Reset mask</button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFile}
              style={{ display: 'none' }}
            />

            <Slider
              label="Brush size"
              value={config.brushSize}
              min={0.05}
              max={0.5}
              step={0.01}
              onChange={(v) => setParam('brushSize', v)}
            />
            <Slider
              label="Brush opacity"
              value={config.brushOpacity}
              min={0.05}
              max={1.0}
              step={0.01}
              onChange={(v) => setParam('brushOpacity', v)}
            />
            <Slider
              label="Noise scale"
              value={config.noiseScale}
              min={0.5}
              max={16}
              step={0.1}
              onChange={(v) => setParam('noiseScale', v)}
            />
            <Slider
              label="Displacement"
              value={config.displacement}
              min={0}
              max={0.2}
              step={0.005}
              onChange={(v) => setParam('displacement', v)}
            />
            <Slider
              label="Edge softness"
              value={config.edgeSoftness}
              min={0.05}
              max={0.95}
              step={0.01}
              onChange={(v) => setParam('edgeSoftness', v)}
            />
            <Slider
              label="Wet halo"
              value={config.wetHalo}
              min={1.0}
              max={4.0}
              step={0.05}
              onChange={(v) => setParam('wetHalo', v)}
            />
            <Slider
              label="Settle speed"
              value={config.settleSpeed}
              min={0.05}
              max={2.0}
              step={0.01}
              onChange={(v) => setParam('settleSpeed', v)}
            />
          </div>
        )}
      </div>

      <div className="portrait-lock" role="status" aria-live="polite">
        <div className="rotate-device" aria-hidden="true">
          <div className="device-shape" />
          <div className="rotate-arc" />
        </div>
        <p>Rotate device to landscape</p>
      </div>
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange }) {
  const digits = step < 0.01 ? 3 : 2
  return (
    <label className="slider">
      <span>
        {label}
        <em>{value.toFixed(digits)}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
      />
    </label>
  )
}
