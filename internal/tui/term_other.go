//go:build !linux && !darwin && !freebsd && !netbsd && !openbsd && !dragonfly && !windows

package tui

import (
	"errors"
	"os"
)

func isTerminal(*os.File) bool { return false }

func makeRaw(*os.File) (func(), error) { return nil, errors.New("tui: raw mode unsupported") }
