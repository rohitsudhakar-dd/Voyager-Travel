package store

import (
	"crypto/rand"
	"sync"
	"time"
)

// Crockford base32: no I, L, O or U, so an id read aloud off a demo screen
// cannot be mistyped.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

var entropyMutex sync.Mutex

// NewSearchID returns a lexicographically sortable id in the shape
// 05-FUNCTIONALITY.md § 2.3 shows: `srch_01J8...`.
//
// The layout is a ULID -- 48 bits of millisecond timestamp followed by 80
// bits of randomness -- which keeps ids sortable by creation time without
// needing a counter anywhere.
func NewSearchID() string {
	return "srch_" + newULID()
}

func newULID() string {
	timestamp := uint64(time.Now().UTC().UnixMilli())

	entropyMutex.Lock()
	random := make([]byte, 10)
	_, err := rand.Read(random)
	entropyMutex.Unlock()
	if err != nil {
		// Failing to read the system RNG is not a recoverable condition, but
		// a search id is not worth taking the process down for. Time alone
		// still gives a usable, if less unique, id.
		for i := range random {
			random[i] = byte(timestamp >> (i % 8))
		}
	}

	out := make([]byte, 26)
	for i := 9; i >= 0; i-- {
		out[i] = crockford[timestamp&0x1f]
		timestamp >>= 5
	}

	// The remaining 16 characters carry the 80 random bits, five at a time.
	bits, bitCount, index := uint32(0), 0, 10
	for _, b := range random {
		bits = bits<<8 | uint32(b)
		bitCount += 8
		for bitCount >= 5 {
			bitCount -= 5
			out[index] = crockford[(bits>>uint(bitCount))&0x1f]
			index++
		}
	}
	return string(out)
}
