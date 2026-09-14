import { describe, expect, test } from 'bun:test'

import { parseNetworkInterfaces } from './probe'

const SAMPLE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  123456    789    0    0    0     0          0         0   123456     789    0    0    0     0       0          0
  eth0:  456789    123    0    0    0     0          0         0   456789     123    0    0    0     0       0          0
`

describe('parseNetworkInterfaces', () => {
  test('extracts interface names past the two header lines', () => {
    expect(parseNetworkInterfaces(SAMPLE)).toEqual(['lo', 'eth0'])
  })

  test('handles an isolated namespace with only loopback', () => {
    const isolated = SAMPLE.split('\n').slice(0, 3).join('\n')
    expect(parseNetworkInterfaces(isolated)).toEqual(['lo'])
  })

  test('returns nothing for empty output rather than throwing', () => {
    expect(parseNetworkInterfaces('')).toEqual([])
  })
})
