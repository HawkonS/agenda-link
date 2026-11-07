import { useState } from "react";
import { cn } from "../../lib/utils";

export function UserAvatar({
  name,
  src,
  className,
}: {
  name?: string;
  src?: string | null;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src && src !== failedSrc);
  return (
    <span className={cn("avatar overflow-hidden", className)}>
      {showImage ? (
        <img
          src={src!}
          alt={`${name || "用户"}的头像`}
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src!)}
        />
      ) : (
        <span aria-label={`${name || "用户"}的默认头像`}>
          {(name || "U").trim().slice(0, 1) || "U"}
        </span>
      )}
    </span>
  );
}
