import { OperatorsPage } from "./Operators";

/** /team/operators — the same Operators page in branch (super-manager) scope. */
export default function TeamOperators() {
  return <OperatorsPage scope="super" />;
}
