import { describe, expect, it } from 'vitest'
import { VideoSourceSchema } from './schemas'

// The second real pure module, and a stronger proof than a class merger: this
// one parses with zod, so it exercises the validation library and the type
// inference the engine's message schemas will rely on.
const validSource = {
  url: 'https://cdn.example.com/clip.mp4',
  type: 'mp4',
  title: 'Example',
  timestamp: 1_700_000_000_000,
}

describe('VideoSourceSchema', () => {
  it('accepts a minimal valid source', () => {
    const parsed = VideoSourceSchema.parse(validSource)
    expect(parsed.url).toBe(validSource.url)
    expect(parsed.type).toBe('mp4')
  })

  it('keeps the optional fields when they are present', () => {
    const parsed = VideoSourceSchema.parse({
      ...validSource,
      quality: '1080p',
      size: '12.4 MB',
      mime: 'video/mp4',
      thumbnail: 'https://cdn.example.com/thumb.jpg',
    })
    expect(parsed.quality).toBe('1080p')
    expect(parsed.size).toBe('12.4 MB')
  })

  it('rejects a source with no url', () => {
    const withoutUrl: Record<string, unknown> = { ...validSource }
    delete withoutUrl.url
    expect(VideoSourceSchema.safeParse(withoutUrl).success).toBe(false)
  })

  it('rejects a type outside the enum', () => {
    expect(
      VideoSourceSchema.safeParse({ ...validSource, type: 'quicktime' }).success
    ).toBe(false)
  })

  it('rejects a timestamp that is not a number', () => {
    expect(
      VideoSourceSchema.safeParse({ ...validSource, timestamp: 'yesterday' })
        .success
    ).toBe(false)
  })
})
