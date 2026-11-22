import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeActivatableSkills, resolveSkillActivationTarget } from './skill-activation-target.ts'

const html = { id: 'dsh-work-html-page', name: 'HTML 页面（平台内置）', version: '1.0.0' }
const office = { id: 'dsh-work-office-document', name: 'Office 文档（平台内置）', version: '1.0.0' }
const installed = { id: 'skill-c70d97a6-32b', name: '应收账款账龄分析', version: '0.1.0' }
const skills = [html, office, installed]

test('activate_skill resolves exact names and ids as before', () => {
  assert.equal(resolveSkillActivationTarget(skills, 'HTML 页面（平台内置）'), html)
  assert.equal(resolveSkillActivationTarget(skills, 'dsh-work-office-document'), office)
  assert.equal(resolveSkillActivationTarget(skills, '  应收账款账龄分析 '), installed)
})

test('activate_skill accepts the catalog forms models actually send', () => {
  // 2026-11-20/22 本机 BSK-P2 真实 DSH 运行中，模型第一次激活传入的值
  assert.equal(resolveSkillActivationTarget(skills, 'dsh-work-html-page@1.0.0'), html)
  assert.equal(resolveSkillActivationTarget(skills, 'dsh-work-office-document@1.0.0'), office)
  assert.equal(resolveSkillActivationTarget(skills, '应收账款账龄分析（skill-c70d97a6-32b@0.1.0）'), installed)
  // 目录整行、去掉保留后缀的名称、半角括号、引号与大小写差异
  assert.equal(resolveSkillActivationTarget(skills, 'HTML 页面（平台内置）（dsh-work-html-page@1.0.0）'), html)
  assert.equal(resolveSkillActivationTarget(skills, 'HTML 页面'), html)
  assert.equal(resolveSkillActivationTarget(skills, 'html页面(平台内置)'), html)
  assert.equal(resolveSkillActivationTarget(skills, '`DSH-WORK-HTML-PAGE@1.0.0`'), html)
})

test('activate_skill only matches the locked version and stays unique', () => {
  assert.equal(resolveSkillActivationTarget(skills, 'dsh-work-html-page@2.0.0'), undefined)
  assert.equal(resolveSkillActivationTarget(skills, '应收账款账龄分析（skill-c70d97a6-32b@0.2.0）'), undefined)
  assert.equal(resolveSkillActivationTarget(skills, ''), undefined)
  assert.equal(resolveSkillActivationTarget(skills, '页面'), undefined)
  const duplicated = [{ id: 'a', name: '报告', version: '1.0.0' }, { id: 'b', name: '报告', version: '1.0.0' }]
  assert.equal(resolveSkillActivationTarget(duplicated, '报告'), undefined)
  // 规范化后两个 Skill 撞名（例如只差全角/半角）也不猜
  const lookalike = [{ id: 'x', name: 'Report', version: '1.0.0' }, { id: 'y', name: 'report', version: '1.0.0' }]
  assert.equal(resolveSkillActivationTarget(lookalike, 'REPORT'), undefined)
  assert.equal(resolveSkillActivationTarget(lookalike, 'report'), lookalike[1])
})

test('activate_skill failure lists names the model can retry with', () => {
  assert.equal(describeActivatableSkills([html, installed]), 'HTML 页面（平台内置）（dsh-work-html-page）、应收账款账龄分析（skill-c70d97a6-32b）')
})
