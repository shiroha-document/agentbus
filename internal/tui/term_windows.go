package tui

import (
	"os"

	"golang.org/x/sys/windows"
)

func isTerminal(f *os.File) bool {
	var m uint32
	return windows.GetConsoleMode(windows.Handle(f.Fd()), &m) == nil
}

// makeRaw disables line input, echo and Ctrl-C processing on the console
// input handle, enables VT input (arrow keys arrive as ESC [ A …) and VT
// processing on stdout so the ANSI menu renders. The returned function
// restores both modes.
func makeRaw(f *os.File) (func(), error) {
	in := windows.Handle(f.Fd())
	var oldIn uint32
	if err := windows.GetConsoleMode(in, &oldIn); err != nil {
		return nil, err
	}
	raw := oldIn &^ (windows.ENABLE_LINE_INPUT | windows.ENABLE_ECHO_INPUT | windows.ENABLE_PROCESSED_INPUT)
	raw |= windows.ENABLE_VIRTUAL_TERMINAL_INPUT
	if err := windows.SetConsoleMode(in, raw); err != nil {
		return nil, err
	}
	out := windows.Handle(os.Stdout.Fd())
	var oldOut uint32
	outOK := windows.GetConsoleMode(out, &oldOut) == nil
	if outOK {
		_ = windows.SetConsoleMode(out, oldOut|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING|windows.ENABLE_PROCESSED_OUTPUT)
	}
	return func() {
		_ = windows.SetConsoleMode(in, oldIn)
		if outOK {
			_ = windows.SetConsoleMode(out, oldOut)
		}
	}, nil
}
