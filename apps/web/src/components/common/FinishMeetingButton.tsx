import { Square } from "lucide-react";
import { request } from "../../api";
import { useAction } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Button } from "../ui/button";
import { Confirm } from "./workspace";

export function FinishMeetingButton({
  meeting,
  disabled = false,
  variant = "ghost",
  label = "结束会议",
}: {
  meeting: {
    id: number;
    subject: string;
    status: string;
    createdBy?: number | null;
  };
  disabled?: boolean;
  variant?: "ghost" | "outline";
  label?: string;
}) {
  const { user, isOperator } = useSession();
  const { saving, act } = useAction();
  if (
    meeting.status !== "scheduled" ||
    (!isOperator && meeting.createdBy !== user?.id)
  )
    return null;
  return (
    <Confirm
      title="结束会议"
      description={`结束「${meeting.subject}」后，将在本系统标记为已结束并立即释放高级账号。平台会议及关联日程的原预约保持不变。`}
      onConfirm={() =>
        act(
          () => request(`/meetings/${meeting.id}/finish`, "POST"),
          "会议已结束，高级账号已释放",
        )
      }
    >
      {(show) => (
        <Button
          size="sm"
          variant={variant}
          disabled={disabled || saving}
          onClick={show}
        >
          <Square />
          {label}
        </Button>
      )}
    </Confirm>
  );
}
