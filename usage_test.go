package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnrichArchiveMetadataAnthropicStream(t *testing.T) {
	dir := t.TempDir()
	request := `{"model":"glm-5.3","messages":[{"role":"user","content":"hello"}]}`
	response := "data: {\"type\":\"message_start\",\"message\":{\"model\":\"glm-5.3\",\"usage\":{\"input_tokens\":12,\"output_tokens\":0}}}\n\n" +
		"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n"
	if err := os.WriteFile(filepath.Join(dir, "request.body"), []byte(request), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "response.body"), []byte(response), 0600); err != nil {
		t.Fatal(err)
	}
	meta := metadata{}
	enrichArchiveMetadata(dir, &meta)
	if meta.Model != "glm-5.3" || meta.Usage.PromptTokens != 12 || meta.Usage.CompletionTokens != 7 || meta.Usage.TotalTokens != 19 {
		t.Fatalf("unexpected metadata: %+v", meta)
	}
}
