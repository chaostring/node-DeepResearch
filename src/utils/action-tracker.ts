import {EventEmitter} from 'events';
import {StepAction} from '../types';
import {getI18nText} from "./text-tools";

// 动作状态接口，用于跟踪当前状态
interface ActionState {
  thisStep: StepAction;    // 当前步骤的动作
  gaps: string[];          // 需要解决的问题或知识缺口
  totalStep: number;       // 总步骤数
}

// 动作跟踪器类，用于跟踪和记录代理执行的动作
export class ActionTracker extends EventEmitter {
  // 初始化动作状态
  private state: ActionState = {
    thisStep: {action: 'answer', answer: '', references: [], think: ''}, // 默认为回答动作
    gaps: [],               // 初始没有知识缺口
    totalStep: 0            // 初始步骤数为0
  };

  // 更新动作状态并触发事件
  trackAction(newState: Partial<ActionState>) {
    this.state = {...this.state, ...newState};
    this.emit('action', this.state.thisStep);
  }

  // 跟踪思考过程并支持国际化
  trackThink(think: string, lang?: string, params = {}) {
    if (lang) {
      // 如果提供了语言，则获取对应语言的文本
      think = getI18nText(think, lang, params);
    }
    // 更新当前步骤的思考内容并触发事件
    this.state = {...this.state, thisStep: {...this.state.thisStep, URLTargets: [], think} as StepAction};
    this.emit('action', this.state.thisStep);
  }

  // 获取当前动作状态的副本
  getState(): ActionState {
    return {...this.state};
  }

  // 重置动作状态到初始值
  reset() {
    this.state = {
      thisStep: {action: 'answer', answer: '', references: [], think: ''},
      gaps: [],
      totalStep: 0
    };
  }
}
