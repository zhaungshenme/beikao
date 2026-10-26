import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import StudyWorkspace from '@/views/study/StudyWorkspace.vue';

createApp(StudyWorkspace).use(createPinia()).use(ElementPlus, { locale: zhCn }).mount('#app');
