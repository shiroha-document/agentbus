package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/shiroha-document/agentbus/internal/i18n"
)

// Attachment limits (contract §4).
const (
	maxAttachments    = 6
	maxAttachmentSize = 10 << 20
)

type attachFile struct {
	name, mime string
	data       []byte
}

// readAttachments loads the --attach files and checks the limits before
// anything is uploaded.
func readAttachments(paths []string) ([]attachFile, error) {
	if len(paths) > maxAttachments {
		return nil, &exitError{code: exitUsage, msg: fmt.Sprintf(i18n.Pick("at most %d --attach files per post", "每条帖子最多 %d 个 --attach 文件"), maxAttachments)}
	}
	var out []attachFile
	for _, p := range paths {
		fi, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if fi.IsDir() {
			return nil, &exitError{code: exitUsage, msg: fmt.Sprintf(i18n.Pick("--attach %s: is a directory", "--attach %s：是目录"), p)}
		}
		if fi.Size() > maxAttachmentSize {
			return nil, &exitError{code: exitUsage, msg: fmt.Sprintf(i18n.Pick("--attach %s: %d bytes is over the 10 MB limit", "--attach %s：%d 字节，超过 10 MB 上限"), p, fi.Size())}
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		if len(data) > maxAttachmentSize {
			return nil, &exitError{code: exitUsage, msg: fmt.Sprintf(i18n.Pick("--attach %s: over the 10 MB limit", "--attach %s：超过 10 MB 上限"), p)}
		}
		out = append(out, attachFile{name: filepath.Base(p), mime: detectMime(p, data), data: data})
	}
	return out, nil
}

// detectMime guesses from the extension, then from the content.
func detectMime(name string, data []byte) string {
	if m := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); m != "" {
		return m
	}
	return http.DetectContentType(data)
}

// attachKey makes the idempotency key depend on the attached files, so the
// same body with other files is a new post.
func attachKey(files []attachFile) string {
	if len(files) == 0 {
		return ""
	}
	h := sha256.New()
	for _, f := range files {
		s := sha256.Sum256(f.data)
		fmt.Fprintf(h, "%s\n%x\n", f.name, s)
	}
	return "\n" + hex.EncodeToString(h.Sum(nil))
}

// ---- agentbus file get ID [-o PATH] [--force] ----

func cmdFile(c *cli, args []string) error {
	if len(args) == 0 || args[0] != "get" {
		return &exitError{code: exitUsage, msg: "file get ID [-o PATH|-] [--force]"}
	}
	fs := newFlags("file get")
	outPath := fs.String("o", "", "write to PATH (- = stdout; default: the attachment name in the current directory)")
	force := fs.Bool("force", false, "overwrite an existing file")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	if err := need(pos, 1, i18n.Pick("attachment id", "附件 id")); err != nil {
		return err
	}
	id := strings.TrimSpace(pos[0])
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	target := *outPath
	if target == "" {
		target = attachmentName(id)
	}
	if target != "-" && !*force {
		if _, err := os.Stat(target); err == nil {
			return &exitError{code: exitErr, msg: fmt.Sprintf(i18n.Pick("%s already exists; pass --force to overwrite or -o PATH", "%s 已存在；加 --force 覆盖，或用 -o PATH 另存"), target)}
		}
	}
	data, err := e.cl.Download(ctx, id)
	if err != nil {
		return err
	}
	if target == "-" {
		_, err := c.out.Write(data)
		return err
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return err
	}
	abs, _ := filepath.Abs(target)
	c.emit(map[string]any{"id": id, "path": abs, "size": len(data)}, func() {
		fmt.Fprintf(c.out, i18n.Pick("saved %s (%d bytes) to %s\n", "已保存 %s（%d 字节）到 %s\n"), id, len(data), target)
	})
	return nil
}

// attachmentName is the safe local file name for an attachment: the name the
// current thread lists for it, else the id.
func attachmentName(id string) string {
	name := ""
	if n, ok := knownAttachmentNames()[id]; ok {
		name = n
	}
	name = safeFileName(name)
	if name == "" {
		return safeFileName(id)
	}
	return name
}

// knownAttachmentNames maps attachment ids to names from the posts of
// $AGENTBUS_THREAD (best effort; empty outside a round).
var knownAttachmentNames = func() map[string]string {
	t := strings.TrimSpace(os.Getenv("AGENTBUS_THREAD"))
	if t == "" {
		return nil
	}
	e, err := loadHub()
	if err != nil {
		return nil
	}
	ctx, cancel := cmdContext()
	defer cancel()
	r, err := e.cl.Posts(ctx, t, "", 100)
	if err != nil {
		return nil
	}
	out := map[string]string{}
	for _, p := range r.Posts {
		for _, a := range p.Attachments {
			out[a.ID] = a.Name
		}
	}
	return out
}

// safeFileName strips directories and characters that are unsafe in file
// names, so a hostile attachment name cannot escape the current directory.
func safeFileName(s string) string {
	s = strings.ReplaceAll(s, "\\", "/")
	s = filepath.Base("/" + s)
	if s == "/" || s == "." || s == ".." {
		return ""
	}
	s = strings.Map(func(r rune) rune {
		switch {
		case r < 0x20, strings.ContainsRune(`<>:"/\|?*`, r):
			return '_'
		}
		return r
	}, s)
	s = strings.TrimLeft(strings.TrimSpace(s), ".")
	return s
}
