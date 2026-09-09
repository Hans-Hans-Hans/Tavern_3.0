// Copyright 2026 Tavern contributors.
// SPDX-License-Identifier: Apache-2.0

// Apply only the pinned, checksum-verified unified patches used by this build.
// No fuzzy matching, offsets, renames, symlinks, binary patches or shell tools.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const maxFile = 4 << 20

var hunk = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n$`)

func lines(value string) []string {
	parts := strings.SplitAfter(value, "\n")
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}

func number(value string, omitted int) (int, error) {
	if value == "" {
		return omitted, nil
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 || n > maxFile {
		return 0, errors.New("invalid patch count")
	}
	return n, nil
}

func safeFile(root, name string) (string, error) {
	if !filepath.IsLocal(name) || name == "." || strings.ContainsAny(name, "\\\r\n\t\x00") {
		return "", errors.New("invalid patch path")
	}
	path := filepath.Join(root, filepath.FromSlash(name))
	for current := path; current != root; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil && !os.IsNotExist(err) {
			return "", fmt.Errorf("cannot inspect patch path %s: %w", current, err)
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("patch paths cannot contain symlinks")
		}
	}
	return path, nil
}

func apply(root string, patch []byte) error {
	if len(patch) == 0 || len(patch) > maxFile || strings.ContainsRune(string(patch), '\r') {
		return errors.New("invalid patch size or line endings")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("patch source root must be an existing directory")
	}
	input := lines(string(patch))
	pending := make(map[string][]byte)
	for i := 0; i < len(input); {
		if !strings.HasPrefix(input[i], "--- ") || i+1 >= len(input) || !strings.HasPrefix(input[i+1], "+++ b/") {
			return errors.New("invalid patch file headers")
		}
		old := strings.TrimSuffix(strings.TrimPrefix(input[i], "--- "), "\n")
		name := strings.TrimSuffix(strings.TrimPrefix(input[i+1], "+++ b/"), "\n")
		if old != "/dev/null" && old != "a/"+name {
			return errors.New("patch renames are unsupported")
		}
		path, err := safeFile(root, name)
		if err != nil {
			return err
		}
		if _, duplicate := pending[path]; duplicate {
			return errors.New("duplicate patch file")
		}
		var data []byte
		if old == "/dev/null" {
			if _, err := os.Lstat(path); !os.IsNotExist(err) {
				return errors.New("new patch file already exists or is unavailable")
			}
		} else {
			info, err := os.Stat(path)
			if err != nil || !info.Mode().IsRegular() || info.Size() > maxFile {
				return errors.New("patch source is unavailable or oversized")
			}
			data, err = os.ReadFile(path)
			if err != nil {
				return err
			}
		}
		source, output, cursor := lines(string(data)), []string{}, 0
		i += 2
		found := false
		for i < len(input) && strings.HasPrefix(input[i], "@@ ") {
			found = true
			match := hunk.FindStringSubmatch(input[i])
			if match == nil {
				return errors.New("invalid patch hunk")
			}
			values := make([]int, 4)
			for index := range values {
				values[index], err = number(match[index+1], 1)
				if err != nil {
					return err
				}
			}
			start, oldCount, newStart, newCount := values[0], values[1], values[2], values[3]
			if start > 0 && oldCount > 0 {
				start--
			}
			if newStart > 0 && newCount > 0 {
				newStart--
			}
			if start < cursor || start > len(source) {
				return errors.New("patch hunk is out of order or range")
			}
			output = append(output, source[cursor:start]...)
			cursor = start
			if newStart != len(output) {
				return errors.New("patch hunk output position does not match")
			}
			i++
			for consumed, produced := 0, 0; consumed < oldCount || produced < newCount; i++ {
				if i >= len(input) || len(input[i]) < 2 {
					return errors.New("truncated patch hunk")
				}
				prefix, content := input[i][0], input[i][1:]
				if prefix != ' ' && prefix != '-' && prefix != '+' {
					return errors.New("unsupported patch hunk line")
				}
				if prefix != '+' {
					if consumed >= oldCount || cursor >= len(source) || source[cursor] != content {
						return errors.New("patch source context does not match exactly")
					}
					consumed++
					cursor++
				}
				if prefix != '-' {
					if produced >= newCount {
						return errors.New("patch output count does not match")
					}
					output = append(output, content)
					produced++
				}
			}
		}
		if !found {
			return errors.New("patch file contains no hunks")
		}
		output = append(output, source[cursor:]...)
		result := []byte(strings.Join(output, ""))
		if len(result) > maxFile {
			return errors.New("patch output is oversized")
		}
		pending[path] = result
	}
	// Validate every hunk before mutating any source file.
	for path, result := range pending {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(path, result, 0644); err != nil {
			return err
		}
	}
	return nil
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: apply SOURCE_ROOT VERIFIED_PATCH")
		os.Exit(2)
	}
	info, err := os.Stat(os.Args[2])
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxFile {
		fmt.Fprintln(os.Stderr, "patch file is unavailable or oversized")
		os.Exit(1)
	}
	patch, err := os.ReadFile(os.Args[2])
	if err == nil {
		err = apply(os.Args[1], patch)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "patch failed:", err)
		os.Exit(1)
	}
}
