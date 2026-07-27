import { useLocation } from "react-router-dom";
import { usePageHeader } from "../store/page";
import { Card } from "../components/ui";

interface Props {
  title: string;
  subtitle?: string;
}

export default function Placeholder({ title, subtitle }: Props) {
  const loc = useLocation();
  usePageHeader({ title, subtitle }, [loc.pathname]);
  return (
    <div className="mx-auto max-w-[1180px]">
      <Card padded className="grid place-items-center min-h-[280px]">
        <div className="text-center">
          <div className="text-[15px] font-semibold mb-1">Скоро появится</div>
          <div className="text-[13px] text-muted">
            Экран «{title}» в разработке — вернитесь позже.
          </div>
        </div>
      </Card>
    </div>
  );
}
