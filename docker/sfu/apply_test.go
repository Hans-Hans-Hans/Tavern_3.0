// Copyright 2026 Tavern contributors.
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExactPatchAndNewFile(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "existing"), []byte("before\nold\nafter\n"), 0644); err != nil {
		t.Fatal(err)
	}
	patch := "--- a/existing\n+++ b/existing\n@@ -1,3 +1,4 @@\n before\n-old\n+new\n+added\n after\n--- /dev/null\n+++ b/nested/new\n@@ -0,0 +1 @@\n+created\n"
	if err := apply(root, []byte(patch)); err != nil {
		t.Fatal(err)
	}
	for name, expected := range map[string]string{"existing": "before\nnew\nadded\nafter\n", "nested/new": "created\n"} {
		actual, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || string(actual) != expected {
			t.Fatalf("unexpected patched file %s: %v", name, err)
		}
	}
}

func TestInvalidPatchCannotPartiallyModifySources(t *testing.T) {
	valid := "--- a/existing\n+++ b/existing\n@@ -1 +1 @@\n-original\n+replacement\n"
	for _, invalid := range []string{
		strings.ReplaceAll(valid, "original", "different"),
		strings.ReplaceAll(valid, "existing", "../escaped"),
		strings.ReplaceAll(valid, "existing", "/absolute"),
		strings.ReplaceAll(valid, "existing", "folder\\escaped"),
		strings.ReplaceAll(valid, "@@ -1 +1 @@", "@@ -2 +1 @@"),
		strings.ReplaceAll(valid, "@@ -1 +1 @@", "@@ -1 +2 @@"),
		strings.ReplaceAll(valid, "@@ -1 +1 @@", "@@ -999999999999999999999 +1 @@"),
		strings.ReplaceAll(valid, "+++ b/existing", "+++ b/renamed"),
		strings.ReplaceAll(valid, "\n", "\r\n"),
		valid + "--- /dev/null\n+++ b/another\n@@ -0,0 +1 @@\n",
		valid + valid,
	} {
		root := t.TempDir()
		path := filepath.Join(root, "existing")
		if err := os.WriteFile(path, []byte("original\n"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := apply(root, []byte(invalid)); err == nil {
			t.Fatalf("invalid patch was accepted: %q", invalid)
		}
		contents, err := os.ReadFile(path)
		if err != nil || string(contents) != "original\n" {
			t.Fatal("a rejected patch changed its source")
		}
	}
}

func TestEmptyRangeInsertionAndDeletion(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "existing")
	if err := os.WriteFile(path, []byte("before\nafter\n"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, patch := range []string{
		"--- a/existing\n+++ b/existing\n@@ -1,0 +2 @@\n+inserted\n",
		"--- a/existing\n+++ b/existing\n@@ -2 +1,0 @@\n-inserted\n",
	} {
		if err := apply(root, []byte(patch)); err != nil {
			t.Fatal(err)
		}
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != "before\nafter\n" {
		t.Fatal("empty-range patch moved the wrong line")
	}
}

func TestPatchRejectsSymlink(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skip("platform does not permit symlink creation")
	}
	if err := apply(root, []byte("--- /dev/null\n+++ b/linked/escaped\n@@ -0,0 +1 @@\n+no\n")); err == nil {
		t.Fatal("patch followed a directory symlink")
	}
}
