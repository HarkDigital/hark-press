import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'

/**
 * Print-shop sound (WebAudio). STUB — the UI build replaces the internals.
 * Keep the public API: enabled, onChange, toggle(), update(), cut(), blip(), tone()
 */
export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []
  toggle() {
    this.enabled = !this.enabled
    for (const fn of this.onChange) fn(this.enabled)
  }
  update(_frame: Frame, _state: EngineState) {}
  cut(_from: number, _to: number) {}
  blip(_pitch = 0) {}
  tone(_hz: number, _level: number) {}
}
