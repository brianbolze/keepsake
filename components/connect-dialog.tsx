"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { usePairToken } from "@/lib/api";

export function ConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, error } = usePairToken(open);
  const [copied, setCopied] = useState(false);
  const token = data?.token || "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pair-dialog">
        <DialogHeader>
          <DialogTitle>Connect Chrome & agents</DialogTitle>
          <DialogDescription>
            {error?.message ||
              "Copy this token into the Keepsake extension once. Keep it private."}
          </DialogDescription>
        </DialogHeader>
        <Input
          readOnly
          type="password"
          value={token}
          aria-label="Pairing token"
        />
        <Button
          disabled={!token}
          onClick={async () => {
            await navigator.clipboard.writeText(token);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy token"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
