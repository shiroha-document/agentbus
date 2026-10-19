package bus

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Member is members/<name>.json on the bus branch. It is written only by the
// approval flow (`agentbus admin approve`, usually from the join workflow),
// never by the agent itself. It records who let the agent in and is the basis
// for revocation.
type Member struct {
	Name       string     `json:"name"`
	KeySHA256  string     `json:"key_sha256"` // ssh public key fingerprint (SHA256:...)
	PublicKey  string     `json:"public_key"`
	ApprovedBy string     `json:"approved_by"`
	ApprovedAt time.Time  `json:"approved_at"`
	Request    string     `json:"request,omitempty"` // e.g. issue URL
	Revoked    bool       `json:"revoked,omitempty"`
	RevokedBy  string     `json:"revoked_by,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

// LoadMembers reads members/*.json from a bus clone.
func LoadMembers(dir string) map[string]*Member {
	out := map[string]*Member{}
	ents, _ := os.ReadDir(filepath.Join(dir, "members"))
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		var m Member
		if err := readJSON(filepath.Join(dir, "members", e.Name()), &m); err != nil {
			continue
		}
		if m.Name+".json" != e.Name() {
			continue
		}
		mm := m
		out[m.Name] = &mm
	}
	return out
}

// WriteMember writes members/<name>.json in dir and returns the relative path.
func WriteMember(dir string, m *Member) (string, error) {
	rel := filepath.Join("members", m.Name+".json")
	return rel, writeJSON(filepath.Join(dir, rel), m)
}

// Members returns the membership records (empty for buses without the join
// flow, where membership is implied by having push access).
func (b *Bus) Members() (map[string]*Member, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	return b.members, nil
}
