import { Redirect } from "expo-router";

/** 入口页：直接进入声音库（功能列表见左上角面包屑） */
export default function Index() {
  return <Redirect href="/voices" />;
}
